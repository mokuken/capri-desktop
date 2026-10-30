'use strict';

// OpenCode plugin -> Capri.
// Subscribes to OpenCode's events and tool hooks and forwards a trimmed copy
// to the Capri app over HTTP. Observe only: never block a tool or a turn.
const PORT = Number(process.env.CAPRI_PORT) || 47823;

function post(evt) {
  try {
    if (!evt || typeof evt !== 'object') return;
    const body = JSON.stringify(evt);
    const req = (globalThis.fetch || null);
    if (req) {
      fetch(`http://127.0.0.1:${PORT}/event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }).catch(() => {});
      return;
    }
  } catch { /* ignore */ }
  // fallback for runtimes without fetch
  try {
    const http = require('node:http');
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 600 },
      (res) => { res.resume(); });
    r.on('error', () => {});
    r.on('timeout', () => { r.destroy(); });
    r.end(body);
  } catch { /* ignore */ }
}

function sid(s) { return `opencode:${s || 'default'}`; }
function base(directory, s) { return { session_id: sid(s), cwd: directory || process.cwd() }; }

function mapTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'read':
      return { tool_name: 'Read', tool_input: { file_path: a.filePath || a.path || a.file || '' } };
    case 'write':
      return { tool_name: 'Write', tool_input: { file_path: a.filePath || a.path || a.file || '', content_len: typeof a.content === 'string' ? a.content.length : 0 } };
    case 'edit':
      return { tool_name: 'Edit', tool_input: { file_path: a.filePath || a.path || a.file || '', old_string_len: typeof a.oldString === 'string' ? a.oldString.length : (typeof a.old_string === 'string' ? a.old_string.length : 0), new_string_len: typeof a.newString === 'string' ? a.newString.length : (typeof a.new_string === 'string' ? a.new_string.length : 0) } };
    case 'bash':
      return { tool_name: 'Bash', tool_input: { command: String(a.command || a.cmd || '').slice(0, 280) } };
    case 'grep':
      return { tool_name: 'Grep', tool_input: { pattern: String(a.pattern || a.query || '').slice(0, 280) } };
    case 'glob':
      return { tool_name: 'Glob', tool_input: { pattern: String(a.pattern || a.path || '*').slice(0, 280) } };
    case 'webfetch':
      return { tool_name: 'WebFetch', tool_input: { url: String(a.url || '').slice(0, 280) } };
    case 'websearch':
      return { tool_name: 'WebSearch', tool_input: { query: String(a.query || '').slice(0, 280) } };
    case 'task':
      return { tool_name: 'Agent', tool_input: { description: String(a.description || a.prompt || 'subagent').slice(0, 280), subagent_type: String(a.subagent_type || a.agent || 'agent').slice(0, 100) } };
    default:
      return { tool_name: name || 'Tool', tool_input: {} };
  }
}

function safe(fn) {
  return async (...args) => { try { return await fn(...args); } catch { /* never get in OpenCode's way */ } };
}

const CapriPlugin = async (input) => {
  const directory = input?.directory || input?.worktree || process.cwd();
  const lastAssistant = new Map(); // sessionID -> text
  function track(sessionID, text) {
    if (!sessionID) return;
    if (typeof text === 'string' && text.trim()) lastAssistant.set(sessionID, text.trim().slice(0, 6000));
  }

  return {
    event: safe(async ({ event }) => {
      const p = event?.properties || {};
      const sessionID = p.sessionID || p.info?.id;
      switch (event?.type) {
        case 'session.created': {
          const info = p.info || {};
          const sid_ = info.id || sessionID;
          post({ ...base(directory, sid_), hook_event_name: 'SessionStart', source: 'startup' });
          lastAssistant.set(sid_, '');
          break;
        }
        case 'session.idle': {
          const txt = lastAssistant.get(sessionID) || '';
          lastAssistant.set(sessionID, '');
          post({ ...base(directory, sessionID), hook_event_name: 'Stop', last_assistant_message: txt });
          break;
        }
        case 'session.status': {
          if (p.status?.type === 'idle') {
            const txt = lastAssistant.get(p.sessionID) || '';
            lastAssistant.set(p.sessionID, '');
            post({ ...base(directory, p.sessionID), hook_event_name: 'Stop', last_assistant_message: txt });
          }
          break;
        }
        case 'permission.updated':
        case 'permission.asked': {
          post({ ...base(directory, sessionID), hook_event_name: 'Notification', notification_type: 'permission_prompt', title: 'Permission needed', message: p.title || p.permission || p.pattern || 'Permission needed' });
          break;
        }
        case 'message.part.updated': {
          const part = p.part;
          if (part?.type === 'text') {
            const delta = typeof p.delta === 'string' ? p.delta : null;
            if (delta) {
              const prev = lastAssistant.get(part.sessionID) || '';
              lastAssistant.set(part.sessionID, prev + delta);
            } else if (typeof part.text === 'string') {
              lastAssistant.set(part.sessionID, part.text);
            }
          }
          break;
        }
        default:
          break;
      }
    }),
    'chat.message': safe(async (input, output) => {
      const text = (output?.parts || []).filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n').trim();
      if (text) post({ ...base(directory, input?.sessionID), hook_event_name: 'UserPromptSubmit', prompt: text.slice(0, 280) });
    }),
    'tool.execute.before': safe(async (input, output) => {
      const name = input?.tool;
      const mapped = mapTool(name, output?.args);
      post({ ...base(directory, input?.sessionID), hook_event_name: 'PreToolUse', ...mapped });
      if (name === 'task') {
        post({ ...base(directory, input?.sessionID), hook_event_name: 'SubagentStart', agent_type: mapped.tool_input.subagent_type });
      }
    }),
    'tool.execute.after': safe(async (input, output) => {
      const name = input?.tool;
      const mapped = mapTool(name, input?.args);
      if (output && (output.error || output.metadata?.error)) {
        post({ ...base(directory, input?.sessionID), hook_event_name: 'PostToolUseFailure', ...mapped, error: String(output.error || output.metadata?.error).slice(0, 280) });
      } else {
        post({ ...base(directory, input?.sessionID), hook_event_name: 'PostToolUse', ...mapped });
      }
      if (name === 'task') {
        post({ ...base(directory, input?.sessionID), hook_event_name: 'SubagentStop', agent_type: mapped.tool_input.subagent_type });
      }
    }),
    'permission.ask': safe(async (input, output) => {
      post({ ...base(directory, input?.sessionID), hook_event_name: 'Notification', notification_type: 'permission_prompt', title: 'Permission needed', message: input?.title || input?.permission || 'Permission needed' });
    }),
  };
};

export default CapriPlugin;
export { CapriPlugin };
