/* Marge — pure monthly budget calculations. No DOM, storage, or bank actions. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BudgetEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_AMOUNT = 1000000000;
  var MAX_BUDGET_ITEMS = 1000;
  var NUMBER_FIELDS = [
    'budgetCA', 'budgetR', 'budgetTotal', 'remainder', 'effectiveRemainder',
    'deficit', 'bufferAvailable', 'bufferUsed', 'shortfall', 'savingsAdd',
    'surplus', 'rBonus', 'caBonus', 'tamponBonus', 'availableCA', 'availableR',
    'bufferEndPlan', 'transferR', 'transferSavings', 'bankCATarget',
    'openingTotal', 'openingCANormalized', 'savingsProjected'
  ];

  function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function invalidResult(errors) {
    var result = { valid: false, funded: false, errors: errors };
    NUMBER_FIELDS.forEach(function (key) { result[key] = null; });
    return result;
  }

  function precisionOK(value, scale) {
    var scaled = value * scale;
    // Accept binary floating-point noise (e.g. 0.1 + 0.2), not fractions of cents.
    return Math.abs(scaled - Math.round(scaled)) <= Math.max(1e-8, Math.abs(scaled) * Number.EPSILON * 4);
  }

  function money(value, label, errors, allowNegative) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(label + ' doit être un nombre fini.');
      return null;
    }
    if (Math.abs(value) > MAX_AMOUNT || (!allowNegative && value < 0)) {
      errors.push(label + (allowNegative
        ? ' doit être compris entre −1 milliard et 1 milliard d’euros.'
        : ' doit être compris entre 0 et 1 milliard d’euros.'));
      return null;
    }
    if (!precisionOK(value, 100)) {
      errors.push(label + ' doit comporter au maximum deux décimales.');
      return null;
    }
    return Math.round(value * 100) || 0;
  }

  function percentage(value, label, errors) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || !precisionOK(value, 10)) {
      errors.push(label + ' doit être un pourcentage de 0 à 100, avec une décimale au maximum.');
      return null;
    }
    return Math.round(value * 10);
  }

  function euros(cents) { return cents / 100 || 0; }

  // Largest-remainder allocation: every cent is assigned exactly once.
  // An exact tie goes to the buffer, then CA, then Revolut.
  function splitSurplus(cents, caPct, rPct, tPct) {
    var parts = [
      { key: 'tamponBonus', pct: tPct, priority: 0 },
      { key: 'caBonus', pct: caPct, priority: 1 },
      { key: 'rBonus', pct: rPct, priority: 2 }
    ];
    var assigned = 0;
    parts.forEach(function (part) {
      var numerator = cents * part.pct;
      part.value = Math.floor(numerator / 1000);
      part.remainder = numerator % 1000;
      assigned += part.value;
    });
    var ranked = parts.slice().sort(function (a, b) {
      return b.remainder - a.remainder || a.priority - b.priority;
    });
    for (var i = 0; i < cents - assigned; i += 1) ranked[i].value += 1;
    var result = {};
    parts.forEach(function (part) { result[part.key] = part.value; });
    return result;
  }

  /**
   * calculate(month) -> complete plan in euros, or {valid:false,...,errors:[French strings]}.
   * Required month fields: salary, openingCA, openingR, savingsOpening (numbers),
   * salaryIncluded/useBuffer (booleans), budget (array), rules (object).
   * Budget rows: {id:string,name:string,category:string,account:'ca'|'r',amount:number,enabled:boolean}.
   * Rule fields: threshold (euros), savingPct/rPct/caPct/tPct (0–100, max one decimal).
   * rPct + caPct + tPct must equal 100. All money uses whole cents internally.
   * salaryIncluded means the salary has already been included in openingCA only.
   * Monetary inputs accept at most two decimals, and absolute values <= 1 billion euros.
   * All fields are required; no implicit coercion or hidden default rules.
   * Savings are rounded to the nearest cent, half up. Surplus is the exact remainder.
   * A valid but unfunded plan is only a proposal: shortfall > 0, no savings/bonuses.
   * transferR > 0: CA -> Revolut; transferR < 0: Revolut -> CA.
   * transferSavings = savingsAdd. bankCATarget = availableCA + bufferEndPlan.
   * Existing savings are held separately; all remaining buffer is assigned to CA.
   * Does not mutate month or initiate any transfer.
   */
  function calculate(month) {
    var errors = [];
    if (!object(month)) return invalidResult(['Le mois doit être un objet.']);

    var salary = money(month.salary, 'Le salaire', errors, false);
    var rawCA = money(month.openingCA, 'Le solde CA', errors, true);
    var openingR = money(month.openingR, 'Le solde Revolut', errors, true);
    var savingsOpening = money(month.savingsOpening, 'L’épargne initiale', errors, false);
    if (typeof month.salaryIncluded !== 'boolean') errors.push('Indiquer si le salaire est déjà inclus dans le solde CA.');
    if (typeof month.useBuffer !== 'boolean') errors.push('Le choix d’utiliser le tampon doit être vrai ou faux.');

    var rules = object(month.rules) ? month.rules : {};
    if (!object(month.rules)) errors.push('Les règles de répartition doivent être un objet.');
    var threshold = money(rules.threshold, 'Le seuil du surplus', errors, false);
    var savingPct = percentage(rules.savingPct, 'La part d’épargne', errors);
    var rPct = percentage(rules.rPct, 'La part Revolut du surplus', errors);
    var caPct = percentage(rules.caPct, 'La part CA du surplus', errors);
    var tPct = percentage(rules.tPct, 'La part tampon du surplus', errors);
    if (rPct !== null && caPct !== null && tPct !== null && rPct + caPct + tPct !== 1000) {
      errors.push('Les parts CA, Revolut et tampon du surplus doivent totaliser 100 %.');
    }

    var budgetCA = 0;
    var budgetR = 0;
    var ids = Object.create(null);
    if (!Array.isArray(month.budget) || month.budget.length > MAX_BUDGET_ITEMS) {
      errors.push('Le budget doit être une liste de 1 000 postes au maximum.');
    } else {
      month.budget.forEach(function (row, index) {
        var label = 'Le poste budgétaire ' + (index + 1);
        if (!object(row)) { errors.push(label + ' doit être un objet.'); return; }
        if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200) {
          errors.push(label + ' doit posséder un identifiant texte valide.');
        } else if (ids[row.id]) {
          errors.push(label + ' possède un identifiant déjà utilisé.');
        } else ids[row.id] = true;
        if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300) errors.push(label + ' doit avoir un nom de 1 à 300 caractères.');
        if (typeof row.category !== 'string' || row.category.length > 200) errors.push(label + ' doit avoir une catégorie texte de 200 caractères au maximum.');
        if (row.account !== 'ca' && row.account !== 'r') errors.push(label + ' doit être rattaché à CA ou Revolut.');
        if (typeof row.enabled !== 'boolean') errors.push(label + ' doit préciser s’il est actif.');
        var amount = money(row.amount, 'Le montant du poste ' + (index + 1), errors, false);
        if (row.enabled === true && amount !== null) {
          if (row.account === 'ca') budgetCA += amount;
          if (row.account === 'r') budgetR += amount;
        }
      });
    }
    if (budgetCA + budgetR > MAX_AMOUNT * 100) errors.push('Le budget total ne peut pas dépasser 1 milliard d’euros.');
    if (errors.length) return invalidResult(errors);

    var openingCA = rawCA - (month.salaryIncluded ? salary : 0);
    var openingTotal = openingCA + openingR;
    var budgetTotal = budgetCA + budgetR;
    var remainder = salary - budgetTotal;
    // A net overdraft is settled before any saving or discretionary allocation.
    var effectiveRemainder = remainder + Math.min(0, openingTotal);
    var deficit = Math.max(0, -effectiveRemainder);
    var bufferAvailable = Math.max(0, openingTotal);
    var bufferUsed = month.useBuffer ? Math.min(deficit, bufferAvailable) : 0;
    var shortfall = deficit - bufferUsed;
    var funded = shortfall === 0;

    var savingsAdd = 0;
    var surplus = 0;
    if (funded && effectiveRemainder >= 0) {
      savingsAdd = effectiveRemainder < threshold
        ? effectiveRemainder
        : Math.round(effectiveRemainder * savingPct / 1000);
      surplus = effectiveRemainder - savingsAdd;
    }
    var split = splitSurplus(surplus, caPct, rPct, tPct);
    var availableCA = budgetCA + split.caBonus;
    var availableR = budgetR + split.rBonus;
    var bufferEndPlan = bufferAvailable - bufferUsed + split.tamponBonus;
    var cents = {
      budgetCA: budgetCA, budgetR: budgetR, budgetTotal: budgetTotal,
      remainder: remainder, effectiveRemainder: effectiveRemainder,
      deficit: deficit, bufferAvailable: bufferAvailable, bufferUsed: bufferUsed,
      shortfall: shortfall, savingsAdd: savingsAdd, surplus: surplus,
      rBonus: split.rBonus, caBonus: split.caBonus, tamponBonus: split.tamponBonus,
      availableCA: availableCA, availableR: availableR, bufferEndPlan: bufferEndPlan,
      transferR: availableR - openingR, transferSavings: savingsAdd,
      bankCATarget: availableCA + bufferEndPlan,
      openingTotal: openingTotal, openingCANormalized: openingCA,
      savingsProjected: savingsOpening + savingsAdd
    };
    var result = { valid: true, funded: funded, errors: [] };
    NUMBER_FIELDS.forEach(function (key) { result[key] = euros(cents[key]); });
    return result;
  }

  /**
   * closeMonth(month, actual) -> {valid,errors,planFunded,closingCA,closingR,
   *   bufferActual,deltaVsOpening,deltaVsPlan,savingsActual,savingsDelta}.
   * actual requires numeric closingCA, closingR, savingsActual.
   * savingsActual is the total savings balance at closing, NOT a contribution.
   * The real buffer is closingCA + closingR: old reserves are never added again.
   * deltaVsOpening compares with normalized openingTotal; deltaVsPlan compares
   * with bufferEndPlan. A valid unfunded plan can still be reconciled with reality.
   * Invalid input returns valid:false, planFunded:false, numeric fields:null.
   */
  function closeMonth(month, actual) {
    var plan = calculate(month);
    var errors = plan.errors.slice();
    var result = {
      valid: false, errors: errors, planFunded: false,
      closingCA: null, closingR: null, bufferActual: null,
      deltaVsOpening: null, deltaVsPlan: null, savingsActual: null, savingsDelta: null
    };
    if (!object(actual)) {
      errors.push('La clôture doit être un objet.');
      return result;
    }
    var closingCA = money(actual.closingCA, 'Le solde CA à la clôture', errors, true);
    var closingR = money(actual.closingR, 'Le solde Revolut à la clôture', errors, true);
    var savingsActual = money(actual.savingsActual, 'L’épargne réelle à la clôture', errors, false);
    if (errors.length) return result;
    var bufferActual = closingCA + closingR;
    result.valid = true;
    result.planFunded = plan.funded;
    result.closingCA = euros(closingCA);
    result.closingR = euros(closingR);
    result.bufferActual = euros(bufferActual);
    result.deltaVsOpening = euros(bufferActual - Math.round(plan.openingTotal * 100));
    result.deltaVsPlan = euros(bufferActual - Math.round(plan.bufferEndPlan * 100));
    result.savingsActual = euros(savingsActual);
    result.savingsDelta = euros(savingsActual - Math.round(month.savingsOpening * 100));
    return result;
  }

  return Object.freeze({ calculate: calculate, closeMonth: closeMonth });
});
