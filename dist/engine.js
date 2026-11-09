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

  function daysInMonth(year, month) {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].indexOf(month) !== -1 ? 30 : 31;
  }

  // Preserve the local calendar printed in an ISO string; do not round-trip its
  // month through UTC. The timestamp is used only to order actual observations.
  function parseCheckpointDate(value) {
    if (typeof value !== 'string') return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
    if (!match) return null;
    var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    var timestamp;
    if (match[4] === undefined) {
      var local = new Date(0);
      local.setFullYear(year, month - 1, day);
      local.setHours(0, 0, 0, 0);
      timestamp = local.getTime();
    } else {
      var hours = Number(match[4]), minutes = Number(match[5]), seconds = Number(match[6] || 0);
      var milliseconds = Number((match[7] || '').padEnd(3, '0'));
      if (hours > 23 || minutes > 59 || seconds > 59) return null;
      var offset = 0, zone = match[8];
      if (zone !== 'Z') {
        var offsetHours = Number(zone.slice(1, 3)), offsetMinutes = Number(zone.slice(4, 6));
        if (offsetHours > 23 || offsetMinutes > 59) return null;
        offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '-' ? -1 : 1);
      }
      var utc = new Date(0);
      utc.setUTCFullYear(year, month - 1, day);
      utc.setUTCHours(hours, minutes, seconds, milliseconds);
      timestamp = utc.getTime() - offset * 60000;
    }
    return { year: year, month: month, day: day, key: value.slice(0, 7), timestamp: timestamp };
  }

  /**
   * validateCheckpoints(month) -> French error strings; never mutates the month.
   * checkpoints is optional (legacy), otherwise at most 93 observations:
   * {date:'YYYY-MM-DD' or ISO datetime with Z/offset,balanceCA,balanceR}.
   * Dates must be real, unique (also by instant), and in month.key according to
   * the calendar written in the date. Date-only values mean local midnight.
   * Optional checkpointTransfers maps exact checkpoint date strings to signed
   * cumulative {r,savings} transfers. Orphan snapshot keys are rejected.
   * This validation is intentionally separate from calculate(), which also
   * accepts standalone plans with no month key or observation history.
   */
  function validateCheckpoints(month) {
    var errors = [];
    if (!object(month)) return ['Le mois doit être un objet.'];
    var points = month.checkpoints === undefined ? [] : month.checkpoints;
    var dateKeys = Object.create(null), instants = Object.create(null);
    if (!Array.isArray(points) || points.length > 93) {
      errors.push('Les relevés doivent être une liste de 93 points au maximum.');
    } else {
      var validMonth = typeof month.key === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month.key);
      if (points.length && !validMonth) errors.push('Le mois des relevés doit respecter le format AAAA-MM.');
      points.forEach(function (point, index) {
        var label = 'Le relevé ' + (index + 1);
        if (!object(point)) { errors.push(label + ' doit être un objet.'); return; }
        var parsed = parseCheckpointDate(point.date);
        if (!parsed) errors.push(label + ' doit porter une date réelle au format ISO (date seule ou heure avec fuseau).');
        else {
          if (validMonth && parsed.key !== month.key) errors.push(label + ' doit appartenir au mois ' + month.key + '.');
          if (dateKeys[point.date] || instants[parsed.timestamp]) errors.push(label + ' possède une date déjà utilisée.');
          dateKeys[point.date] = true;
          instants[parsed.timestamp] = true;
        }
        money(point.balanceCA, 'Le solde CA du relevé ' + (index + 1), errors, true);
        money(point.balanceR, 'Le solde Revolut du relevé ' + (index + 1), errors, true);
      });
    }
    if (month.checkpointTransfers !== undefined) {
      var snapshots = month.checkpointTransfers;
      if (!object(snapshots) || Object.keys(snapshots).length > 93) {
        errors.push('Les virements des relevés doivent former une liste de 93 instantanés au maximum.');
      } else Object.keys(snapshots).forEach(function (date) {
        if (!dateKeys[date]) errors.push('Les virements du ' + date + ' ne correspondent à aucun relevé.');
        var snapshot = snapshots[date];
        if (!object(snapshot)) { errors.push('Les virements du ' + date + ' doivent préciser Revolut et le Livret A.'); return; }
        money(snapshot.r, 'Le virement cumulé Revolut du ' + date, errors, true);
        money(snapshot.savings, 'Le virement cumulé Livret A du ' + date, errors, true);
      });
    }
    return errors;
  }

  /**
   * elapsedMonthPct('YYYY-MM', now = new Date()) -> number in [0,100], or null.
   * Includes the current day: day / daysInMonth * 100. Past months are 100,
   * future months 0. Date objects use the runtime's local calendar. ISO strings
   * retain their written local date (including when an explicit offset is used).
   * Invalid keys, rolled-over dates and invalid Date objects return null.
   */
  function elapsedMonthPct(key, now) {
    if (typeof key !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return null;
    if (now === undefined) now = new Date();
    var current;
    if (typeof now === 'string') current = parseCheckpointDate(now);
    else {
      try {
        var time = Date.prototype.getTime.call(now);
        if (!Number.isFinite(time)) return null;
        var date = new Date(time);
        current = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
      } catch (_) { return null; }
    }
    if (!current) return null;
    var targetIndex = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
    var currentIndex = current.year * 12 + current.month - 1;
    if (targetIndex < currentIndex) return 100;
    if (targetIndex > currentIndex) return 0;
    return current.day / daysInMonth(current.year, current.month) * 100;
  }

  function accountTracking(budgetCents, spentCents, elapsedPct) {
    var spentPct = budgetCents > 0 ? spentCents / budgetCents * 100 : null;
    return {
      budget: euros(budgetCents), spent: euros(spentCents),
      spentPct: spentPct, barPct: spentPct === null ? 0 : Math.min(100, Math.max(0, spentPct)),
      remaining: euros(budgetCents - spentCents),
      paceDifferencePct: spentPct === null ? null : spentPct - elapsedPct,
      netInflow: spentCents < 0,
      ahead: spentPct !== null && spentPct > elapsedPct
    };
  }

  /**
   * checkpointTransferState(month, last = null) ->
   * {valid,errors,source,executed,targets,pending,complete,snapshot,
   *  snapshotSource,changedSinceCheckpoint}.
   * source: 'executed' for explicit cumulative movements (always authoritative),
   * 'legacy-done' if an old done:true flag supplies a missing executed history,
   * otherwise 'none'. Legacy checked flags mean the corresponding full target;
   * the app must materialize that migration before changing a legacy plan.
   * executed/targets/pending are {r,savings} in signed euros; complete holds
   * booleans. pending = targets - executed, calculated with whole cents.
   * last may be an existing checkpoint (only its date is required here).
   * snapshot is null without last, otherwise the recorded snapshot or executed
   * fallback. snapshotSource is 'checkpoint' / 'executed-fallback' / null.
   * changedSinceCheckpoint compares the recorded movements to current executed.
   * No mutation, coercion or transfer execution. Invalid input returns false,
   * French errors and null amount maps. Snapshot/history validation remains
   * available separately through validateCheckpoints().
   */
  function checkpointTransferState(month, last) {
    var plan = calculate(month);
    var errors = plan.errors.slice();
    var result = { valid: false, errors: errors, source: null, executed: null,
      targets: null, pending: null, complete: null, snapshot: null,
      snapshotSource: null, changedSinceCheckpoint: false };
    if (!object(month)) return result;
    if (last === undefined) last = null;
    if (last !== null && (!object(last) || !parseCheckpointDate(last.date))) {
      errors.push('Le relevé de référence doit porter une date ISO valide.');
    }
    var done = month.done;
    if (done !== undefined && (!object(done) || typeof done.r !== 'boolean' || typeof done.savings !== 'boolean')) {
      errors.push('Les anciens pointages doivent préciser vrai ou faux pour Revolut et le Livret A.');
    }
    if (month.checkpointTransfers !== undefined && !object(month.checkpointTransfers)) {
      errors.push('Les instantanés de virements doivent être un objet.');
    }
    if (errors.length) return result;

    var targetR = Math.round(plan.transferR * 100);
    var targetSavings = Math.round(plan.savingsAdd * 100);
    var paidR, paidSavings, source;
    if (month.executed !== undefined) {
      source = 'executed';
      if (!object(month.executed)) {
        errors.push('Les virements effectués doivent préciser Revolut et le Livret A.');
        return result;
      }
      paidR = money(month.executed.r, 'Le virement Revolut effectué', errors, true);
      paidSavings = money(month.executed.savings, 'Le virement Livret A effectué', errors, true);
    } else {
      source = done && (done.r || done.savings) ? 'legacy-done' : 'none';
      paidR = done && done.r ? targetR : 0;
      paidSavings = done && done.savings ? targetSavings : 0;
    }
    if (errors.length) return result;

    var snapshot = null, snapshotSource = null, changed = false;
    if (last !== null) {
      var snapshots = month.checkpointTransfers;
      var hasSnapshot = snapshots && Object.prototype.hasOwnProperty.call(snapshots, last.date);
      var savedR = paidR, savedSavings = paidSavings;
      if (hasSnapshot) {
        var saved = snapshots[last.date];
        if (!object(saved)) {
          errors.push('Les virements du relevé doivent préciser Revolut et le Livret A.');
          return result;
        }
        savedR = money(saved.r, 'Le virement Revolut du relevé', errors, true);
        savedSavings = money(saved.savings, 'Le virement Livret A du relevé', errors, true);
      }
      if (errors.length) return result;
      snapshot = { r: euros(savedR), savings: euros(savedSavings) };
      snapshotSource = hasSnapshot ? 'checkpoint' : 'executed-fallback';
      changed = savedR !== paidR || savedSavings !== paidSavings;
    }
    result.valid = true;
    result.source = source;
    result.executed = { r: euros(paidR), savings: euros(paidSavings) };
    result.targets = { r: euros(targetR), savings: euros(targetSavings) };
    result.pending = { r: euros(targetR - paidR), savings: euros(targetSavings - paidSavings) };
    result.complete = { r: targetR === paidR, savings: targetSavings === paidSavings };
    result.snapshot = snapshot;
    result.snapshotSource = snapshotSource;
    result.changedSinceCheckpoint = changed;
    return result;
  }

  /**
   * checkpointTracking(month, now = new Date()) ->
   * {valid,errors,latest,elapsedPct,transferSnapshotSource,transferSnapshot,accounts}.
   * latest is a shallow copy of the most recent checkpoint by instant, not array
   * order. With no checkpoint latest/accounts/snapshot/source are null.
   * transferSnapshotSource is 'checkpoint' or 'executed-fallback'. Missing
   * snapshots explicitly fall back to checkpointTransferState().executed,
   * including legacy done:true flags when no explicit executed history exists.
   * Transfers are cumulative actual movements: r > 0 CA->R; savings > 0 CA->livret.
   * Negative values represent the reverse movement. Future pointages do not
   * change a checkpoint that already has its own snapshot.
   * accounts.ca/r = {budget,spent,spentPct,barPct,remaining,paceDifferencePct,
   * netInflow:boolean,ahead:boolean}. Budgets include monthly surplus bonuses.
   * spent is net consumption, not a transaction ledger: negative values indicate
   * net outside inflows. Percentages remain signed/unbounded; only bars clamp.
   * Invalid inputs return valid:false and null tracking fields, never throw.
   */
  function checkpointTracking(month, now) {
    var plan = calculate(month);
    var errors = plan.errors.concat(validateCheckpoints(month));
    var elapsed = elapsedMonthPct(object(month) ? month.key : undefined, now);
    if (elapsed === null) errors.push('Le mois ou la date de suivi est invalide.');
    var result = { valid: false, errors: errors, latest: null, elapsedPct: elapsed,
      transferSnapshotSource: null, transferSnapshot: null, accounts: null };
    if (errors.length) return result;
    var points = month.checkpoints || [];
    if (!points.length) { result.valid = true; return result; }
    var latest = points.reduce(function (last, point) {
      return !last || parseCheckpointDate(point.date).timestamp > parseCheckpointDate(last.date).timestamp ? point : last;
    }, null);
    var snapshots = month.checkpointTransfers;
    var hasSnapshot = snapshots && Object.prototype.hasOwnProperty.call(snapshots, latest.date);
    var snapshot;
    if (hasSnapshot) snapshot = snapshots[latest.date];
    else {
      var transfers = checkpointTransferState(month, latest);
      if (!transfers.valid) { Array.prototype.push.apply(errors, transfers.errors); return result; }
      snapshot = transfers.executed;
    }
    var transferR = money(snapshot.r, 'Le virement Revolut effectué', errors, true);
    var transferSavings = money(snapshot.savings, 'Le virement Livret A effectué', errors, true);
    if (errors.length) return result;
    var spentCA = Math.round(plan.openingCANormalized * 100) + Math.round(month.salary * 100)
      - transferR - transferSavings - Math.round(latest.balanceCA * 100);
    var spentR = Math.round(month.openingR * 100) + transferR - Math.round(latest.balanceR * 100);
    result.valid = true;
    result.latest = Object.assign({}, latest);
    result.transferSnapshotSource = hasSnapshot ? 'checkpoint' : 'executed-fallback';
    result.transferSnapshot = { r: euros(transferR), savings: euros(transferSavings) };
    result.accounts = {
      ca: accountTracking(Math.round(plan.availableCA * 100), spentCA, elapsed),
      r: accountTracking(Math.round(plan.availableR * 100), spentR, elapsed)
    };
    return result;
  }

  return Object.freeze({ calculate: calculate, closeMonth: closeMonth,
    validateCheckpoints: validateCheckpoints, elapsedMonthPct: elapsedMonthPct,
    checkpointTracking: checkpointTracking, checkpointTransferState: checkpointTransferState });
});
