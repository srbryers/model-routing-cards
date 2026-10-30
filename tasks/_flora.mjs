/** Pipeline cards select approved roles. Calibration needs real job evidence. */
import { profile } from '../scripts/flora.mjs';
export function floraTask(id) {
  const config = profile.roles[id];
  const route = profile.routes[config.selectedRoute];
  return {
    id, pipelineRole: true, modelConfig: config,
    models: [{ provider: route.provider === 'claude-code' ? 'claude' : route.provider, model: route.model }],
    runs: 3, calibration: { status: 'UNCALIBRATED', reason: 'No controlled role calibration' },
    input: { role: id, purpose: config.purpose, requiredEvidence: config.outcomeFields },
    prompt: input => `Role: ${input.role}\nGoal: ${input.purpose}\nUse the accepted contract and exact candidate. Return full evidence for: ${input.requiredEvidence.join(', ')}.\nMissing contract, source, or evidence blocks execution.`,
    score: () => { throw new Error('Role calibration requires the approved job evidence harness; static card only'); },
    weights: {},
  };
}
