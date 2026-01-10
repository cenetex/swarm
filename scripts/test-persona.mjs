#!/usr/bin/env node
/**
 * Test an agent's persona by having a conversation with it
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentsPath = path.join(__dirname, '..', 'agents');

const agentId = process.argv[2];

if (!agentId) {
  console.error('Usage: pnpm test:persona <agent-id>');
  console.error('\nAvailable agents:');
  
  const agents = fs.readdirSync(agentsPath)
    .filter(f => {
      const fullPath = path.join(agentsPath, f);
      return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
    });
  
  agents.forEach(a => console.log(`  - ${a}`));
  process.exit(1);
}

const agentPath = path.join(agentsPath, agentId);
const configPath = path.join(agentPath, 'config.yaml');
const personaPath = path.join(agentPath, 'persona.md');

if (!fs.existsSync(configPath)) {
  console.error(`Agent not found: ${agentId}`);
  console.error(`Expected config at: ${configPath}`);
  process.exit(1);
}

const config = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
const persona = fs.existsSync(personaPath) 
  ? fs.readFileSync(personaPath, 'utf-8')
  : 'You are a helpful AI assistant.';

console.log(`\n🤖 Testing agent: ${config.name || agentId}`);
console.log(`📝 Persona loaded (${persona.length} chars)`);
console.log(`\nType messages to test the persona. Type 'exit' to quit.\n`);
console.log('─'.repeat(60));

// Check for API key
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.warn('\n⚠️  OPENROUTER_API_KEY not set. Set it to enable AI responses.');
  console.log('   For now, showing what would be sent to the LLM.\n');
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages = [];

async function chat(userMessage) {
  messages.push({ role: 'user', content: userMessage });
  
  if (!apiKey) {
    console.log('\n[Would send to LLM with system prompt:]');
    console.log(`  Model: ${config.llm?.model || 'anthropic/claude-sonnet-4'}`);
    console.log(`  Messages: ${messages.length}`);
    console.log(`  Last user message: "${userMessage}"`);
    return;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm?.model || 'anthropic/claude-sonnet-4',
        messages: [
          { role: 'system', content: persona },
          ...messages,
        ],
        temperature: config.llm?.temperature || 0.8,
        max_tokens: config.llm?.maxTokens || 1024,
      }),
    });

    const data = await response.json();
    
    if (data.error) {
      console.error('\n❌ API Error:', data.error.message);
      return;
    }

    const reply = data.choices?.[0]?.message?.content;
    if (reply) {
      messages.push({ role: 'assistant', content: reply });
      console.log(`\n🤖 ${config.name || agentId}: ${reply}\n`);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

function prompt() {
  rl.question('You: ', async (input) => {
    const trimmed = input.trim();
    
    if (trimmed.toLowerCase() === 'exit') {
      console.log('\nGoodbye! 👋\n');
      rl.close();
      return;
    }
    
    if (trimmed) {
      await chat(trimmed);
    }
    
    prompt();
  });
}

prompt();
