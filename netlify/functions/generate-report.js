// generate-report.js
//
// Takes the customer's Discovery answers, fills the generate-user prompt
// template, sends it to Claude alongside the generate-system prompt, and
// returns the structured JSON report the model produces.
//
// The Anthropic API key lives only in this server-side function via
// process.env.ANTHROPIC_API_KEY. It is never logged and never sent to
// the browser.

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../../prompts/generate-system.txt'),
  'utf8'
);
const USER_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../../prompts/generate-user.txt'),
  'utf8'
);

function fillTemplate(template, vars) {
  return template.replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

// The spec's accepted fields don't include a reference, but both prompts
// need one. If the front end doesn't send one, we generate one here so
// every report is traceable.
function makeReference() {
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const stamp = Date.now().toString(36).toUpperCase();
  return `BP-${stamp}-${rand}`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ status: 'error', message: 'Method not allowed.' })
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: 'Server is missing an API key.' })
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

  const { customer_name, customer_email, situation, goal, constraint, quick_facts, constraints } = body;

  if (!customer_name || !situation || !goal || !constraint) {
    return {
      statusCode: 400,
      body: JSON.stringify({ status: 'error', message: 'Missing one or more required fields: customer_name, situation, goal, constraint.' })
    };
  }

  const reference = (body.reference && String(body.reference).trim()) || makeReference();
const qf = quick_facts || {};
const constraintsList = Array.isArray(constraints) && constraints.length > 0
  ? constraints.map(c => `- ${c}`).join('\n')
  : '- (none ticked)';

const userPrompt = fillTemplate(USER_TEMPLATE, {
  reference,
  customer_name,
  situation,
  goal,
  constraint,
  hours: qf.hours || '(not provided)',
  capital: qf.capital || '(not provided)',
  public_ok: qf.public_ok || '(not provided)',
  camera_ok: qf.camera_ok || '(not provided)',
  transport: qf.transport || '(not provided)',
  timeline: qf.timeline || '(not provided)',
  constraints_list: constraintsList
});
  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 2000,
        
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    data = await response.json();
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'error', message: 'Could not reach Claude. Please try again.' })
    };
  }

  if (!response.ok) {
    return {
      statusCode: response.status,
      body: JSON.stringify({
        status: 'error',
        message: (data && data.error && data.error.message) || 'Claude could not generate the report.'
      })
    };
  }

 let raw = (data.content || [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n')
  .trim();

// Strip markdown code fences if the model added them
raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

// If the model added preamble before the JSON, grab from the first { to the last }
const firstBrace = raw.indexOf('{');
const lastBrace = raw.lastIndexOf('}');
if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
  raw = raw.slice(firstBrace, lastBrace + 1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: 'error',
      message: 'Could not parse the model response as JSON.',
      debug_preview: raw.slice(0, 300)
    })
  };
}

  if (parsed.status === 'error') {
    return { statusCode: 200, body: JSON.stringify(parsed) };
  }

  // Carry the email and a confirmed reference through to the front end so
  // report.html and send-report.js have what they need downstream. The
  // model was never asked for customer_email, so we attach it here.
  parsed.quick_facts = qf;
  parsed.constraints = Array.isArray(constraints) ? constraints : [];
  parsed.customer_email = customer_email || '';
  parsed.reference = parsed.reference || reference;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
