const handlers = {};

export function onEvent(eventName, handler) {
  if (!handlers[eventName]) handlers[eventName] = [];
  handlers[eventName].push(handler);
}

export async function emitEvent(eventName, payload) {
  const eventHandlers = handlers[eventName] || [];

  for (const handler of eventHandlers) {
    try {
      await handler(payload);
    } catch (err) {
      console.error(`EVENT ERROR: ${eventName}`, err);
    }
  }
}