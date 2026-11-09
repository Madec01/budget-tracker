/* Marge — immutable, chronological monthly carry-forward. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BudgetMonths = factory(root.BudgetEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  var KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
  var MAX_AMOUNT = 1000000000;

  function fail(message) {
    var error = new Error('Report mensuel impossible : ' + message);
    error.code = 'BUDGET_MONTHS_INVALID';
    throw error;
  }
  if (!Engine || typeof Engine.calculate !== 'function' || typeof Engine.closeMonth !== 'function') {
    fail('le moteur de budget doit être chargé avant le module des mois.');
  }

  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function validKey(key) { return typeof key === 'string' && KEY_PATTERN.test(key); }
  function checkKey(key) { if (!validKey(key)) fail('la date du mois doit respecter le format AAAA-MM.'); }
  function cents(value) { return Math.round(value * 100); }
  function euros(value) { return value / 100 || 0; }
  function monthIndex(key) { return Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1; }

  function entriesFor(state) {
    if (!object(state) || !object(state.months)) fail('la liste des mois est invalide.');
    return Object.keys(state.months).sort().map(function (key) {
      checkKey(key);
      var month = state.months[key];
      if (!object(month) || month.key !== key || typeof month.prepared !== 'boolean' || typeof month.closed !== 'boolean') {
        fail('le mois ' + key + ' est invalide.');
      }
      if (month.closed && !month.prepared) fail('le mois ' + key + ' est clôturé sans avoir été préparé.');
      if (month.carry !== undefined && (!object(month.carry) || typeof month.carry.buffer !== 'boolean' || typeof month.carry.savings !== 'boolean')) {
        fail('les options de report du mois ' + key + ' doivent préciser tampon et épargne.');
      }
      return month;
    });
  }

  function contextFor(state) {
    var entries = entriesFor(state);
    var income = state.incomePlan === undefined ? {} : state.incomePlan;
    if (!object(income)) fail('le calendrier des salaires est invalide.');
    Object.keys(income).forEach(function (key) {
      checkKey(key);
      var entry = income[key];
      if (!object(entry) || !validKey(entry.sourcePayroll) || typeof entry.estimated !== 'boolean') {
        fail('la référence de salaire du mois ' + key + ' est invalide.');
      }
      checkReportAmount(entry.salary, 'Le salaire prévisionnel', key, false);
    });
    var keys = Object.create(null);
    entries.forEach(function (month) { keys[month.key] = true; });
    Object.keys(income).forEach(function (key) { keys[key] = true; });
    return { state: state, income: income, keys: Object.keys(keys).sort(), plans: null };
  }

  function validateCalculation(month) {
    var result = Engine.calculate(month);
    if (!result.valid || result.errors.length) fail('mois ' + month.key + ' : ' + result.errors.join(' '));
    return result;
  }

  function checkReportAmount(value, label, key, negativeAllowed) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT || (!negativeAllowed && value < 0)) {
      fail(label + ' à reporter depuis ' + key + ' dépasse les limites autorisées (1 milliard d’euros par solde).');
    }
    var scaled = value * 100;
    if (Math.abs(scaled - Math.round(scaled)) > Math.max(1e-8, Math.abs(scaled) * Number.EPSILON * 4)) {
      fail(label + ' à reporter depuis ' + key + ' doit être exprimé au centime.');
    }
  }

  function withTarget(source, targetKey) {
    if (!source) return null;
    return {
      sourceKey: source.sourceKey,
      sourceClosed: source.sourceClosed,
      skipped: Math.max(0, monthIndex(targetKey) - monthIndex(source.sourceKey) - 1),
      openingCA: source.openingCA,
      openingR: source.openingR,
      savingsOpening: source.savingsOpening,
      bufferTotal: source.bufferTotal,
      provisional: source.provisional
    };
  }

  // Closing balances are authoritative. An open month provides a forecast, or
  // only its opening balances while its budget has not yet been confirmed.
  function sourceFrom(month) {
    var c = validateCalculation(month);
    var ca, r, savings;
    if (month.closed) {
      var closing = Engine.closeMonth(month, month.closing);
      if (!closing.valid || closing.errors.length) fail('clôture du mois ' + month.key + ' : ' + closing.errors.join(' '));
      ca = closing.closingCA;
      r = closing.closingR;
      savings = closing.savingsActual;
    } else if (c.budgetTotal === 0 && month.budgetConfirmed !== true) {
      ca = c.openingCANormalized;
      r = month.openingR;
      savings = month.savingsOpening;
    } else {
      ca = euros(cents(c.bufferEndPlan) - cents(c.shortfall));
      r = 0;
      savings = c.savingsProjected;
    }
    checkReportAmount(ca, 'Le solde CA', month.key, true);
    checkReportAmount(r, 'Le solde Revolut', month.key, true);
    checkReportAmount(savings, 'Le solde d’épargne', month.key, false);
    return {
      sourceKey: month.key, sourceClosed: month.closed,
      openingCA: ca, openingR: r, savingsOpening: savings,
      bufferTotal: euros(cents(ca) + cents(r)), provisional: !month.closed,
      salary: month.salary, budgetReady: c.budgetTotal > 0 || month.budgetConfirmed === true
    };
  }

  function resolveStored(month, report, sourceSalary) {
    if (month.closed) return month;
    var carry = month.prepared
      ? (month.carry || { buffer: false, savings: false })
      : { buffer: !!report, savings: !!report };
    // Legacy prepared months without carry are manual and retain their identity.
    if (month.prepared && (!report || (!carry.buffer && !carry.savings))) return month;
    var result = Object.assign({}, month, { carry: { buffer: carry.buffer, savings: carry.savings } });
    if (!month.prepared && report) result.salary = sourceSalary;
    if (report && carry.buffer) {
      result.openingCA = report.openingCA;
      result.openingR = report.openingR;
      result.salaryIncluded = false;
    }
    if (report && carry.savings) result.savingsOpening = report.savingsOpening;
    return result;
  }

  // A single ordered pass, never recursive. Missing months produce no income.
  function walk(context, targetKey, validateAll) {
    var source = null;
    var anchored = false;
    var months = [];
    for (var i = 0; i < context.keys.length; i += 1) {
      var key = context.keys[i];
      if (targetKey !== null && key >= targetKey) break;
      var stored = context.state.months[key];
      var reference = context.income[key];
      var canProject = !!(reference && source && anchored && source.budgetReady);
      if ((!stored || !stored.prepared) && !canProject && !validateAll) continue;
      var resolved = resolveCandidate(context, key, stored, source, anchored);
      if (resolved.prepared) {
        source = sourceFrom(resolved);
        if ((resolved.closed || resolved.forecast !== true) && source.budgetReady) anchored = true;
        months.push(resolved);
      } else if (validateAll) validateCalculation(resolved);
    }
    return { source: source, anchored: anchored, months: months };
  }

  function defaultPlan(context, key) {
    var state = context.state;
    if (!context.plans) {
      if (!Array.isArray(state.plans) || !state.plans.length) fail('aucun budget par défaut n’est disponible.');
      state.plans.forEach(function (plan) {
        if (!object(plan) || !validKey(plan.from) || !Array.isArray(plan.budget) || !object(plan.rules)) {
          fail('un budget par défaut est invalide.');
        }
      });
      context.plans = state.plans.map(function (plan, index) { return { plan: plan, index: index }; }).sort(function (a, b) {
        return a.plan.from.localeCompare(b.plan.from) || b.index - a.index;
      });
    }
    var low = 0, high = context.plans.length - 1, selected = null;
    while (low <= high) {
      var middle = Math.floor((low + high) / 2);
      var plan = context.plans[middle].plan;
      if (plan.from <= key) { selected = plan; low = middle + 1; }
      else high = middle - 1;
    }
    return selected || state.plans[0];
  }

  function resolveCandidate(context, key, stored, source, anchored) {
    var report = withTarget(source, key);
    if (stored && stored.prepared) return resolveStored(stored, report, source ? source.salary : 0);
    var result;
    if (stored) result = resolveStored(stored, report, source ? source.salary : 0);
    else {
      var plan = defaultPlan(context, key);
      result = {
        key: key, prepared: false, closed: false,
        salary: source ? source.salary : 0,
        openingCA: report ? report.openingCA : 0,
        openingR: report ? report.openingR : 0,
        salaryIncluded: false,
        savingsOpening: report ? report.savingsOpening : 0,
        budget: plan.budget.map(function (row) { return Object.assign({}, row); }),
        rules: Object.assign({}, plan.rules), budgetConfirmed: plan.confirmed === true,
        useBuffer: false, done: { r: false, savings: false },
        carry: { buffer: !!report, savings: !!report }
      };
    }
    var reference = context.income[key];
    if (reference) {
      result = Object.assign({}, result, {
        salary: reference.salary,
        salaryReference: Object.assign({}, reference),
        forecast: !!(source && anchored && source.budgetReady)
      });
      if (result.forecast) result.prepared = true;
    }
    return result;
  }

  /**
   * reportFor(state, key) -> null, or:
   * {sourceKey,sourceClosed,skipped,openingCA,openingR,savingsOpening,bufferTotal,provisional}
   * Uses the latest earlier PREPARED month, resolving its linked predecessors.
   * incomePlan dates may supply virtual prepared forecast months after a real,
   * prepared month with a ready budget has established the projection anchor.
   * skipped counts calendar months between source and target; no missing salary
   * or savings contribution is invented. The target's own manual inputs are ignored.
   * Open forecasts consolidate the buffer on CA; real closings preserve CA/R.
   */
  function reportFor(state, key) {
    checkKey(key);
    var context = contextFor(state);
    return withTarget(walk(context, key, false).source, key);
  }

  /**
   * getMonth(state, key) -> month, without mutating state.
   * New/unprepared months automatically carry buffer and savings when a prior
   * prepared month exists. Prepared months only carry the explicitly true fields
   * in carry:{buffer,savings}; legacy prepared months are manual. Closed months
   * are returned unchanged. Existing budget/rules/other fields are preserved.
   * New months clone their applicable plan and inherit the source salary, unless
   * incomePlan[key] supplies {salary,sourcePayroll,estimated}. Such a planned
   * month is prepared:true,forecast:true only after a real prepared budget anchor;
   * otherwise only its salary is prefilled. Stored prepared months take priority.
   */
  function getMonth(state, key) {
    checkKey(key);
    var context = contextFor(state);
    var stored = state.months[key];
    if (stored && (stored.closed || (stored.prepared && (!stored.carry || (!stored.carry.buffer && !stored.carry.savings))))) {
      return stored;
    }
    var walked = walk(context, key, false);
    var result = resolveCandidate(context, key, stored, walked.source, walked.anchored);
    validateCalculation(result);
    return result;
  }

  /**
   * validateReports(state) -> true, or throws Error with
   * code === 'BUDGET_MONTHS_INVALID' and a French message.
   * Validates every stored month after resolving carry, and every available
   * outgoing report, in one chronological pass. Does not create missing months.
   * All three public functions throw the same error type for invalid inputs.
   */
  function validateReports(state) {
    walk(contextFor(state), null, true);
    return true;
  }

  /**
   * projectionMonths(state) -> chronological array of resolved prepared months,
   * including real stored months and virtual incomePlan forecasts. No mutation,
   * no generated month outside incomePlan, and one shared validation/carry pass.
   */
  function projectionMonths(state) {
    return walk(contextFor(state), null, true).months;
  }

  return Object.freeze({ getMonth: getMonth, reportFor: reportFor, validateReports: validateReports, projectionMonths: projectionMonths });
});
