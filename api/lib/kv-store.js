// Shared Vercel KV / memory-backed JSON list storage helpers.
// Keep this module free of secret logging: tokens are only sent in Authorization headers.

export function storageMode(env = process.env){
  return (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) ? 'vercel-kv' : 'memory';
}

export async function kvRequest(command, { env = process.env, fetchImpl } = {}){
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env not configured');

  const r = await (fetchImpl || fetch)(`${url}/${command}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
  return r.json();
}

export function createJsonListStore({
  key,
  maxItems,
  memoryKey,
  env = process.env,
  fetchImpl
}){
  if (!key) throw new Error('key is required');
  if (!memoryKey) throw new Error('memoryKey is required');

  function currentStorageMode(){
    return storageMode(env);
  }

  async function readList(){
    if (currentStorageMode() === 'vercel-kv') {
      const data = await kvRequest(`get/${encodeURIComponent(key)}`, { env, fetchImpl });
      if (!data?.result) return [];
      if (Array.isArray(data.result)) return data.result;
      return JSON.parse(data.result);
    }

    if (!globalThis[memoryKey]) globalThis[memoryKey] = [];
    return globalThis[memoryKey];
  }

  async function writeList(items){
    const clean = Number.isFinite(maxItems) ? items.slice(0, maxItems) : items;
    if (currentStorageMode() === 'vercel-kv') {
      await kvRequest(`set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(clean))}`, { env, fetchImpl });
      return clean;
    }

    globalThis[memoryKey] = clean;
    return clean;
  }

  return {
    storageMode: currentStorageMode,
    readList,
    writeList
  };
}
