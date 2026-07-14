/* ==================================================================
   logic.js  -  WHY IS THIS BOX IN THIS BUCKET?

   The single source. Loaded by three pages:

     wastenet-monitor.html      the (i) on each of the six buckets
     wastenet-accounting.html   the (i) on each of the four sections
     how-it-works.html          the whole thing, as a guide

   ONE copy. Edit it here and all three change together.

   ------------------------------------------------------------------
   THE RULE THAT KEEPS THIS HONEST

   Do not write numbers down.

   "We flag a box at 80% full" is a sentence that becomes a LIE the day
   somebody changes the threshold to 75%. And it lies with the authority
   of being written down inside the tool, which is worse than saying
   nothing - a new person will believe it over the code.

   So the prose explains the SHAPE of the rule ("we flag when fill
   reaches the box's own trigger") and the numbers are read out of the
   live data at the moment you open the panel. A number that was never
   written down cannot go stale.

   Where a real constant does exist in the engine (168 hours, for
   instance), name it and say where it lives, so the next person knows
   what to grep for.
   ================================================================== */

var LOGIC = {

/* ---------------- BOX MONITOR ---------------- */

action: {
  title: 'Schedule service',
  short: 'Boxes that are full enough to need a pickup arranged.',
  body: [
    'A box lands here when the daily scan says it needs servicing and there is no pickup already booked in CES.',
    'The test is not a fixed percentage. Every box has its OWN trigger, set in CES, because a compactor behind a restaurant fills differently from one behind a warehouse. We compare the box against its own trigger, never against a company-wide number.',
    'Three separate things can put a box here, and any one of them is enough:',
    ['FULL - the fill reading has reached or passed that box\'s trigger.',
     'DAYS - too many days have gone by since the last pickup, past the box\'s days trigger.',
     'CYCLES - the compactor has run more cycles than its cycles trigger since the last pickup.'],
    'A box that is genuinely full but has ALSO stopped cycling shows here rather than in Stale scans, and carries an "also stale" tag. A real fill reading at or over trigger outranks a suspicion that the monitor has gone quiet.',
    'Boxes are grouped by hauler, because scheduling means telephoning a hauler and one call clears all their boxes. Within a hauler they are ordered by the suggested pickup date - the date the box\'s scheduling rule works out to, which is the date you would read down the phone.',
    'A hauler with only one box gets no group header. A group of one is not a group; the row names its own hauler instead.'
  ],
  source: 'CES, via the daily scan at 4:30am Eastern.',
  live: 'triggers'
},

needsempty: {
  title: 'Record empty',
  short: 'The hauler has emptied the box, but nobody has told CES.',
  body: [
    'The box was serviced. The fill reading has dropped. But CES still shows the old pickup as outstanding, because marking a box empty is a manual step that somebody has to remember.',
    'Until it is marked, CES keeps counting days and cycles from the WRONG pickup date - so the box will start shouting that it needs servicing again when it does not.',
    'This bucket is therefore not really a job. It is a piece of tidying that stops the system lying to you tomorrow.',
    'The scan detects it by comparing the fill reading against what CES believes the state of the box is. When the box is plainly empty and CES has not been told, it lands here.'
  ],
  source: 'CES, via the daily scan.',
  live: null
},

monitor: {
  title: 'Monitor down',
  short: 'The sensor on the box has stopped reporting.',
  body: [
    'CES reports a sentinel value of 75000 when a monitor is not sending readings. It is not a fill level; it is CES\'s way of saying "no idea".',
    'This is an EQUIPMENT problem, not a service problem. The box may be full, may be empty - nobody knows, because the thing that would tell us has stopped talking.',
    'A box here is invisible to every other rule on this page. It cannot be flagged as full, cannot be flagged as stale, cannot be scheduled on the strength of a reading, because there is no reading. That is precisely why it needs its own bucket: silence is not the same as "fine".'
  ],
  source: 'CES, via the daily scan. The 75000 sentinel is checked in engine.user.js.',
  live: null
},

stale: {
  title: 'Stale scans',
  short: 'The box has not cycled in a week or more.',
  body: [
    'The compactor has not run. Not "run less" - not run at all - for 168 hours, which is seven days.',
    'That can mean the site is quiet, or a holiday, or a closure. It can also mean the compactor is broken, or the power is off, or somebody has switched it off and forgotten.',
    'This is a SYMPTOM, not an instruction. Nobody needs to do anything today. It is here so that a box which has quietly stopped working does not sit unnoticed for a month.',
    'A stale box that is also genuinely full - a real fill reading at or over its trigger - is NOT shown here. It goes to Schedule service instead, flagged "also stale". A box that needs emptying needs emptying, whatever else is true about it.',
    'The days-over-trigger and cycles-over-trigger readings on a stale box are a CONSEQUENCE of it not cycling, not an independent reason to act. They do not rescue it from this bucket.'
  ],
  source: 'CES, via the daily scan. The 168-hour test lives in isStaleScan() in wastenet-monitor.html.',
  live: null
},

scheduled: {
  title: 'Scheduled',
  short: 'A pickup is already booked. Nothing to do.',
  body: [
    'CES shows a pickup date on the box, so somebody has already arranged it.',
    'The scan detects this by looking for a Delete button beside the box in the Last 400 Days table in CES - because in CES, the presence of a Delete button is what tells you an order exists to be deleted. It is an odd tell, but it is a reliable one.',
    'Informational only. This bucket exists so you can SEE that a box is handled, rather than wondering why it dropped off the action list.',
    'A scheduled box whose pickup date has passed without the box being emptied carries a "missed" flag. That is worth chasing - the hauler said they would come and did not.'
  ],
  source: 'CES, via the daily scan.',
  live: null
},

clear: {
  title: 'No action',
  short: 'Everything else. Boxes that are fine, and boxes that are switched off.',
  body: [
    'Two different things live here, on two tabs.',
    ['ACTIVE - the box is being monitored, is below its trigger, and has nothing wrong with it. This is where most boxes are, most of the time, and that is the point.',
     'INACTIVE - CES has the box marked N/A. It is not being serviced and not being watched. Usually a box that has been removed but not yet deleted.'],
    'Boxes marked "hands off" also ride in the Active tab - sites where somebody has said explicitly that WasteNet does not schedule the service. They are not action items and never will be, but they are not errors either.',
    'If a box you expect to see elsewhere is sitting here, this is the first place to look.'
  ],
  source: 'CES, via the daily scan.',
  live: null
},

/* ---------------- ACCOUNTING ---------------- */

receivables: {
  title: 'Receivables',
  short: 'Money owed to WasteNet. Straight from QuickBooks.',
  body: [
    'Every invoice in QuickBooks with a balance still outstanding. Nothing is computed here - the balance IS whatever QuickBooks says it is.',
    'Aged into buckets by how long past the due date the invoice is: Current, 1-30 days, 31-60, 61-90, and 90+.',
    'QuickBooks is the authority on money. This page never writes to it, never adjusts a balance, never marks anything paid. If a number looks wrong here, it is wrong in QuickBooks, and that is where it must be fixed.'
  ],
  source: 'QuickBooks Online, via the nightly pull (qbo-pull.js on the droplet).',
  live: 'invoices'
},

payments: {
  title: 'Payments',
  short: 'Money received, and which invoice it settled.',
  body: [
    'Every payment recorded in QuickBooks, and the invoice it was applied to.',
    'Money arrives four ways, and only ONE of them records itself:',
    ['PAY-LINK - the customer clicks Pay on the invoice. Intuit takes it and marks the invoice paid the same moment. Nothing for anyone to do. In the bank these arrive batched together as INTUIT deposits, which is why an INTUIT deposit will never equal a single invoice.',
     'ACH - a transfer straight into Frost. Frost names the payer on the statement.',
     'CHEQUE - paper in the post. The bank records the deposit as ONE anonymous lump with no names on it at all.',
     'PAYMODE - an ACH through the Bottomline Paymode network. A remittance email arrives naming the invoice.'],
    'The last three all have to be keyed into QuickBooks by hand. Somebody has to first work out WHO paid - and for cheques, the bank statement cannot tell you.'
  ],
  source: 'QuickBooks Online, via the nightly pull.',
  live: null
},

deposits: {
  title: 'Deposits',
  short: 'The bank statement, reconciled against the books.',
  body: [
    'Drop in a Frost CSV export. Every deposit is sorted into one of four piles.',
    ['ALREADY RECORDED - a payment exists in QuickBooks near that date, for that amount, from that customer. Nothing to do. This is the answer you actually wanted from the bank statement.',
     'TO RECORD - money arrived and no payment was keyed. This is the work.',
     'NOTHING TO DO - a pay-link deposit (Intuit already closed the invoice) or a transfer between your own accounts.',
     'UNEXPLAINED - money in the bank that the books cannot account for. This is the number to care about.'],
    'It reconciles against the PAYMENTS already recorded, NOT against open invoices. That distinction matters: an invoice Kim settled months ago is closed, so searching open invoices for it finds nothing and reports "no match" about a payment that was handled perfectly.',
    'The ACH search window is wide - 45 days - because Costco\'s money lands at Frost on the 3rd and the payment is keyed on the LAST day of the month, every month, as a routine. A tight window called that "unexplained" about an account that pays in full and on time. When the bank has NAMED the payer, an exact amount is strong evidence and the date is only corroboration.',
    'The cheque window stays tight - 12 days - because there is no name to lean on, only arithmetic, and a wide window would multiply false matches.',
    'It writes NOTHING to QuickBooks. Ever. It works out what a deposit paid and shows you; recording it stays a human decision, made in QuickBooks.'
  ],
  source: 'A Frost CSV you upload, matched against the QuickBooks pull and the Payer Map tab.',
  live: 'payers'
},

billing: {
  title: 'Billing',
  short: 'Next month\'s invoices, before they are sent.',
  body: [
    'A draft of what each customer is about to be invoiced, built from the billing log and the box list.',
    'Red means unpaid - the customer has an invoice still outstanding from a previous month. Amber means the box count has changed since last month, so the amount will differ.',
    'A one-time fee can be added, with a description. The DESCRIPTION goes on the invoice and the customer reads it. The internal note does not, and never leaves this system.'
  ],
  source: 'The Billing Map and Billing Edits tabs, plus the QuickBooks pull.',
  live: null
},

agents: {
  title: 'Agents',
  short: 'Commission owed to sales agents.',
  body: [
    'Each agent earns a share of the revenue from the accounts they brought in. The share and the accounts are set in the Agent Map and Agent Settings tabs.',
    'Commission is calculated on money RECEIVED, not money invoiced. An agent is not paid on an invoice the customer has not settled.'
  ],
  source: 'The Agent Map and Agent Settings tabs, against the QuickBooks payments.',
  live: null
},

financials: {
  title: 'Financials',
  short: 'A pulse on the business: what came in, against the two costs that matter.',
  body: [
    'This is not the whole picture of the company, and it does not try to be. It shows revenue against the only two costs it tracks - CES and agent commissions - so you can see at a glance whether the shape of the business is holding. Everything left after those two costs is the gross margin, and a margin that stays steady month after month is the sign that nothing underneath has quietly changed.',
    'The four cards read left to right. Revenue, then CES, then commissions, then what is left. Each cost also shows what slice of revenue it took, so the proportions are as visible as the dollars.',
    'Three numbers feed the page, and they do not all come from the same place:',
    ['REVENUE - money COLLECTED, straight from the same payments the Payments page uses. Not money invoiced. A month is only as big as what actually arrived in the bank.',
     'COMMISSIONS - what the agents earned on that collected money, straight from the Agents page. The two always agree because they are the same underlying figure.',
     'CES - what CES BILLED that month, read off their statements and typed into the CES Costs tab. Billed, not paid, on purpose: payments lag wildly - some months nothing goes out, some months a lump clears several at once - but the cost of monitoring the boxes is steady, and billed is the honest measure of it.'],
    'Because revenue is money collected, it is LUMPY. A large customer whose accounts-payable department skips a month and doubles up the next turns a steady business into a chart that lurches. That is why the dashed BILLED line is drawn across the chart: it is nearly flat, because the same boxes are monitored every month, and it is the truer picture of the work. The gap between the flat billed line and the bouncing collected bars is payment timing, not the business changing.',
    'A month with no CES cost entered is drawn HOLLOW - a dashed outline where its bar would be - and left out of the totals entirely. The margin line breaks across that gap rather than bridging it, because a margin computed without its largest cost would be a flattering fiction. The fix is not in the code: add the month to the CES Costs tab and it fills in.',
    'The year dropdown only offers years CES has been entered for. Add an earlier year to the CES Costs tab and it appears on its own.',
    'What is NOT here: overhead, staff, phones, insurance, and the distributions the owners draw. Those are real money and they are deliberately out of frame. This page answers one question - does the core model still work - and adding everything else would bury the answer.'
  ],
  source: 'Three tabs at once: the QuickBooks payments (revenue and commissions) and the hand-entered CES Costs tab (the CES billed figure). The dashed billed line comes from the QuickBooks invoices.',
  live: 'financials'
}

};

/* The (i) panel. Same content, same markup, on all three pages. */
function logicPanelHtml(key, liveNote) {
  var L = LOGIC[key];
  if (!L) return '';

  var para = function (p) {
    if (Object.prototype.toString.call(p) === '[object Array]') {
      return '<ul class="lg-list">' + p.map(function (li) {
        var m = li.match(/^([A-Z][A-Z\u2011 -]+?)\s+-\s+([\s\S]+)$/);
        return m
          ? '<li><b>' + m[1] + '</b> \u2014 ' + m[2] + '</li>'
          : '<li>' + li + '</li>';
      }).join('') + '</ul>';
    }
    return '<p>' + p + '</p>';
  };

  return '' +
    '<div class="lg-head">' +
      '<div class="lg-title">' + L.title + '</div>' +
      '<div class="lg-short">' + L.short + '</div>' +
    '</div>' +
    '<div class="lg-body">' + L.body.map(para).join('') + '</div>' +
    (liveNote ? '<div class="lg-live">' + liveNote + '</div>' : '') +
    '<div class="lg-src"><b>Where the data comes from</b><br>' + L.source + '</div>';
}

if (typeof module !== 'undefined') module.exports = { LOGIC: LOGIC, logicPanelHtml: logicPanelHtml };
