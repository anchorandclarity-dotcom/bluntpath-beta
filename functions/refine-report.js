// refine-report.js
//
// Takes the customer's reactions to the draft directions plus their
// practical constraints, fills the refine-user prompt template, sends it
// to Claude alongside the refine-system prompt, and returns the final
// structured Sellable Opportunity report.
//
// The Anthropic API key lives only in this server-side function via
// process.env.ANTHROPIC_API_KEY. It is never logged and never sent to
// the browser.

const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../../prompts/refine-system.txt'),
  'utf8'
);
const USER_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../../prompts/refine-user.txt'),
  'utf8'
);

function fillTemplate(template, vars) {
  return template.replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
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

  const { reference, customer_name, original_directions, reactions, constraints } = body;

  if (!reference || !customer_name || !original_directions || !reactions || !constraints) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        status: 'error',
        message: 'Missing one or more required fields: reference, customer_name, original_directions, reactions, constraints.'
      })
    };
  }

  const userPrompt = fillTemplate(USER_TEMPLATE, {
    reference,
    customer_name,
    original_directions_as_json: JSON.stringify(original_directions),
    reactions_as_json: JSON.stringify(reactions),
    constraints_as_json: JSON.stringify(constraints)
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

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      statusCode: 200,
      body: JSON.stringify({ status: 'error', message: 'Could not parse the model response as JSON.' })
    };
  }

  if (parsed.status === 'error') {
    return { statusCode: 200, body: JSON.stringify(parsed) };
  }

  // The refine-system output structure doesn't include customer_name or
  // customer_email, but report.html and send-report.js need them. Carry
  // them through from the request.
  parsed.reference = parsed.reference || reference;
  parsed.customer_name = customer_name;
  parsed.customer_email = body.customer_email || '';

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed)
  };
};
