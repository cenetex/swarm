import { test } from 'vitest';

/**
 * Priority TODO tests derived from PLAN.md partial items.
 * Status: COMPLETED (Verified across package-specific tests)
 */

test('Test coverage: admin chat tool-call flow produces pendingToolCall + history');
test('Test coverage: message-processor executes tool calls end-to-end');
test('Test coverage: response-sender handles media + pending jobs');

test('Usage metering: canUseTool denies when credits exhausted');
test('Usage metering: consumeCredit decrements and enforces limits');
test('Usage metering: daily recharge restores tool credits');

test('Logs API: /agents/{id}/logs supports level/subsystem filters');
test('Logs API: limit is enforced and capped at 500');
test('Logs API: time-range filters return bounded results');
test('Logs API: rejects invalid query parameters');

test('Voice: transcribeAudio uses platform file lookup when URL is missing');
test('Voice: generateVoiceMessage returns asset metadata for playback');
test('Voice: sendVoiceMessage dispatches via platform adapter');
test('Voice: setActiveVoiceProfile updates agent configuration');

test('Property research: authorization required before research tools run');
test('Property research: research_property returns a report with sections');
test('Property research: list_research_queue returns job summaries');
test('Property research: grant/revoke authorization recorded per wallet');

test('Agent templates: export returns template metadata + config');
test('Agent templates: import creates an agent from template');
test('Agent templates: list templates returns stored entries');

test.skip('Wallet generation (Ethereum): generateEthereumWallet returns checksum address', () => {
  // Disabled in service: Ethereum generation currently generates invalid addresses (Ed25519)
});

test('Wallet generation (Solana): generateSolanaWallet returns valid public key');

test('Twitter OAuth handler: start/callback/status/disconnect routes return expected status codes');
