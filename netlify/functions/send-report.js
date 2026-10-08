// send-report.js
//
// Renders a structured report (draft or final shape) into the email
// template and sends it via Resend, either to the reviewer or the
// customer. The Resend API key lives only in this server-side function
// via process.env.RESEND_API_KEY. It is never logged and never sent to
// the browser.

const fs = require('fs');
const path = require('path');

const EMAIL_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../../templates/report-email.html'),
  'utf8'
);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The draft report (from generate-report.js) and the final report (from
// refine-report.js) have different shapes. This renders whichever
// sections are present, so one email template can carry either.
function renderReportBody(report) {
  let html = '';

  if (report.section_1_what_you_told_us) {
    const s1 = report.section_1_what_you_told_us;
    html += `
      <h2>What you told us</h2>
      <p><strong>Situation:</strong> ${esc(s1.situation)}</p>
      <p><strong>Goal:</strong> ${esc(s1.goal)}</p>
      <p><strong>Constraint:</strong> ${esc(s1.constraint)}</p>`;
  }

  if (Array.isArray(report.section_2_what_we_noticed)) {
    html += `<h2>What we noticed</h2><ul>`;
    report.section_2_what_we_noticed.forEach((item) => {
      html += `<li>${esc(item)}</li>`;
    });
    html += `</ul>`;
  }

  if (Array.isArray(report.section_3_directions)) {
    html += `<h2>Possible directions</h2>`;
    report.section_3_directions.forEach((d) => {
      html += `
        <div class="direction">
          <h3>${esc(d.name)}</h3>
          <p>${esc(d.what_it_is)}</p>
          <p><strong>Why it fits:</strong> ${esc(d.why_it_fits)}</p>
          <p><strong>First money move:</strong> ${esc(d.first_money_move)}</p>
          <p><strong>Honest risk:</strong> ${esc(d.honest_risk)}</p>
        </div>`;
    });
  }

  if (report.draft_recommendation) {
    html += `<h2>Provisional leaning</h2><p>${esc(report.draft_recommendation)}</p>`;
  }

  if (report.section_4_reaction_refined) {
    const s4 = report.section_4_reaction_refined;
    html += `
      <h2>Your reactions</h2>
      <p><strong>Yes:</strong> ${esc((s4.yes || []).join(', ') || '—')}</p>
      <p><strong>Maybe:</strong> ${esc((s4.maybe || []).join(', ') || '—')}</p>
      <p><strong>No:</strong> ${esc((s4.no || []).join(', ') || '—')}</p>
      <p>${esc(s4.how_reaction_changed_recommendation)}</p>`;
  }

  if (report.section_5_sellable_opportunity) {
    const s5 = report.section_5_sellable_opportunity;
    html += `
      <h2>Your sellable opportunity</h2>
      <div class="direction">
        <h3>${esc(s5.name)}</h3>
        <p>${esc(s5.one_sentence)}</p>
        <p><strong>Who pays:</strong> ${esc(s5.who_pays)}</p>
        <p><strong>What they pay for:</strong> ${esc(s5.what_they_pay_for)}</p>
        <p><strong>Why you:</strong> ${esc(s5.why_you)}</p>
      </div>`;
  }

  if (report.section_6_first_money_plan) {
    const s6 = report.section_6_first_money_plan;
    html += `
      <h2>First-money plan</h2>
      <p><strong>This week:</strong> ${esc(s6.step_1_this_week)}</p>
      <p><strong>Next week:</strong> ${esc(s6.step_2_next_week)}</p>
      <p><strong>Within 30 days:</strong> ${esc(s6.step_3_within_30_days)}</p>
      <p><strong>What first money looks like:</strong> ${esc(s6.what_first_money_looks_like)}</p>`;
  }

  if (report.section_7_what_could_go_wrong) {
    const s7 = report.section_7_what_could_go_wrong;
    html += `
      <h2>What could go wrong</h2>
      <p>${esc(s7.reason)}</p>
      <p><strong>Adjustment:</strong> ${esc(s7.adjustment)}</p>`;
  }

  if (report.section_8_next_action) {
    html += `<h2>Next action</h2><p>${esc(report.section_8_next_action)}</p>`;
  }

  return html;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ status: 'error', message: 'Method not allowed.' })
    };
  }

  const resendKey = process.env.RESEND_API_KEY;
  const reviewEmail = process.env.REVIEW_EMAIL;

  if (!resendKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: 'Server is missing RESEND_API_KEY.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ status: 'error', message: 'Could not read the request body.' })
    };
  }

  const { report, recipient } = body;

  if (!report || typeof report !== 'object') {
    return {
      statusCode: 400,
      body: JSON.stringify({ status: 'error', message: 'Missing report data.' })
    };
  }

  if (recipient !== 'reviewer' && recipient !== 'customer') {
    return {
      statusCode: 400,
      body: JSON.stringify({ status: 'error', message: 'recipient must be "reviewer" or "customer".' })
    };
  }

  let toAddress;
  if (recipient === 'reviewer') {
    if (!reviewEmail) {
      return {
        statusCode: 500,
        body: JSON.stringify({ status: 'error', message: 'Server is missing REVIEW_EMAIL.' })
      };
    }
    toAddress = reviewEmail;
  } else {
    toAddress = report.customer_email;
    if (!toAddress) {
      return {
        statusCode: 400,
        body: JSON.stringify({ status: 'error', message: 'No customer email was found on this report.' })
      };
    }
  }

  const customerName = report.customer_name || 'there';
  const reference = report.reference || 'BP-UNSET';
  const reportBody = renderReportBody(report);

  const html = EMAIL_TEMPLATE
    .replace(/{{\s*CUSTOMER_NAME\s*}}/g, esc(customerName))
    .replace(/{{\s*REFERENCE\s*}}/g, esc(reference))
    .replace(/{{\s*REPORT_BODY\s*}}/g, reportBody);

  const subject =
    recipient === 'reviewer'
      ? `[Review] ${customerName} — ${reference}`
      : `Your Sellable Opportunity — ${reference}`;

  let response, data;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        // TODO: replace with your verified Resend sending domain/address.
        from: 'Bluntpath <reports@bluntpath.com>',
        to: [toAddress],
        subject,
        html
      })
    });
    data = await response.json();
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: 'Could not reach the email service.' })
    };
  }

  if (!response.ok) {
    return {
      statusCode: response.status,
      body: JSON.stringify({
        status: 'error',
        message: (data && data.message) || 'Resend could not send the email.'
      })
    };
  }

  return { statusCode: 200, body: JSON.stringify({ status: 'ok' }) };
};
