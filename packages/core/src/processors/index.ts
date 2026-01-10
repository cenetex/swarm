/**
 * Processors barrel export
 */
export { 
  MessageEvaluator, 
  createMessageEvaluator,
  type EvaluationResult 
} from './message-evaluator.js';

export { 
  ResponseGenerator, 
  createResponseGenerator,
} from './response-generator.js';

export { 
  OutboundSender, 
  createOutboundSender,
} from './outbound-sender.js';
