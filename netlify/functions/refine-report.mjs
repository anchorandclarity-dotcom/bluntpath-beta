// refine-report.mjs
//
// Takes the customer's reactions to the draft directions plus their
// practical constraints, fills the refine-user prompt template, sends it
// to Claude alongside the refine-system prompt, and returns the final
// structured Sellable Opportunity report.
//
// Anthropic credentials are injected by Netlify AI Gateway at runtime
// (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL). They are never logged and
// never sent to the browser.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { status: 'error', message: 'Method not allowed.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { status: 'error', message: 'Server is missing an API key.' });
  }
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

  let body;
  try {
    const text = await req.text();
    body = JSON.parse(text || '{}');
  } catch (e) {
    return json(400, { status: 'error', message: 'Could not read the request body.' });
  }

  const { reference, customer_name, original_directions, reactions, constraints } = body;

  if (!reference || !customer_name || !original_directions || !reactions || !constraints) {
    return json(400, {
      status: 'error',
      message: 'Missing one or more required fields: reference, customer_name, original_directions, reactions, constraints.'
    });
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
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    data = await response.json();
  } catch (err) {
    return json(500, { status: 'error', message: 'Could not reach Claude. Please try again.' });
  }

  if (!response.ok) {
    return json(response.status, {
      status: 'error',
      message: (data && data.error && data.error.message) || 'Claude could not generate the report.'
    });
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
    return json(200, {
      status: 'error',
      message: 'Could not parse the model response as JSON.',
      debug_preview: raw.slice(0, 300)
    });
  }

  if (parsed.status === 'error') {
    return json(200, parsed);
  }

  // The refine-system output structure doesn't include customer_name or
  // customer_email, but report.html and send-report.js need them. Carry
  // them through from the request.
  parsed.reference = parsed.reference || reference;
  parsed.customer_name = customer_name;
  parsed.customer_email = body.customer_email || '';

  return json(200, parsed);
};
