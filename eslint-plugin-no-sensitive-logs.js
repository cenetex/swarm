/**
 * ESLint Plugin: No Sensitive Logs
 * 
 * Detects console.log/error/warn statements that may expose sensitive data.
 * 
 * Patterns detected:
 * - Logging variables/properties with sensitive names (token, key, secret, password, credential)
 * - Logging full request/response objects
 * - Logging full error objects (may contain sensitive context)
 * 
 * Safe patterns:
 * - Logging error messages only (error.message or String(error))
 * - Logging structured JSON with explicit fields
 * - Logging counts, IDs, or sanitized metadata
 */

const SENSITIVE_PATTERNS = [
  // Variable/property names
  /\b(token|key|secret|password|credential|auth|bearer|apikey|api_key|access_token|refresh_token|private_key|wallet_key)\b/i,
  // Object patterns that might contain sensitive data
  /\b(request|req|response|res|headers?|cookies?|params?|body|payload)\b/i,
];

const SAFE_PATTERNS = [
  // Explicitly accessing .message or safe error handling patterns
  /\berror\s*\.\s*message\b/,
  /String\s*\(\s*error\s*\)/,
  /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*['"`][^'"`]*['"`]/,
  /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)/,
];

function isSensitiveIdentifier(name) {
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(name));
}

function isErrorObjectLog(node) {
  // Check if logging an error object directly (not error.message)
  if (node.type === 'Identifier' && node.name === 'error') {
    return true;
  }
  return false;
}

function getLoggedVariables(args) {
  const variables = [];
  
  for (const arg of args) {
    if (arg.type === 'Identifier') {
      variables.push(arg.name);
    } else if (arg.type === 'MemberExpression') {
      // e.g., request.body, user.token
      if (arg.object.type === 'Identifier') {
        variables.push(arg.object.name);
      }
      if (arg.property.type === 'Identifier') {
        variables.push(arg.property.name);
      }
    } else if (arg.type === 'ObjectExpression') {
      // Check object properties
      for (const prop of arg.properties) {
        if (prop.type === 'Property') {
          if (prop.key.type === 'Identifier') {
            variables.push(prop.key.name);
          }
          // Check the value
          if (prop.value.type === 'Identifier') {
            variables.push(prop.value.name);
          }
        }
      }
    } else if (arg.type === 'SpreadElement') {
      // e.g., ...request
      if (arg.argument.type === 'Identifier') {
        variables.push(`...${arg.argument.name}`);
      }
    }
  }
  
  return variables;
}

function getMessageIdForVariable(varName) {
  if (varName.startsWith('...')) {
    return 'requestResponse';
  }
  const requestResponsePatterns = ['request', 'req', 'response', 'res', 'body', 'headers', 'params'];
  if (requestResponsePatterns.some(p => varName.toLowerCase().includes(p))) {
    return 'requestResponse';
  }
  return 'sensitiveData';
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow console statements that may log sensitive data',
      category: 'Security',
      recommended: true,
    },
    messages: {
      sensitiveData: 'Console statement may log sensitive data: "{{name}}". Use structured logging and sanitize sensitive fields.',
      errorObject: 'Logging full error object may expose sensitive context. Use error.message or String(error) instead.',
      requestResponse: 'Logging full request/response object may expose sensitive headers/cookies. Log specific sanitized fields instead.',
    },
  },
  
  create(context) {
    return {
      CallExpression(node) {
        // Check for console.log, console.error, console.warn
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'console' &&
          node.callee.property.type === 'Identifier' &&
          ['log', 'error', 'warn', 'info', 'debug'].includes(node.callee.property.name)
        ) {
          const sourceCode = context.getSourceCode();
          const code = sourceCode.getText(node);
          
          // Check if this is a safe pattern
          if (SAFE_PATTERNS.some(pattern => pattern.test(code))) {
            return;
          }
          
          // Check for error object logging
          const args = node.arguments;
          for (const arg of args) {
            if (isErrorObjectLog(arg)) {
              context.report({
                node: arg,
                messageId: 'errorObject',
              });
              return;
            }
          }
          
          // Get all variables being logged
          const variables = getLoggedVariables(args);
          
          // Check for sensitive patterns
          for (const varName of variables) {
            if (isSensitiveIdentifier(varName)) {
              context.report({
                node,
                messageId: getMessageIdForVariable(varName),
                data: { name: varName },
              });
              return;
            }
          }
        }
      },
    };
  },
};
