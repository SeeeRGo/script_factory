const REZULT_KEY_PATTERN = /^Rezult_[1-9]\d*$/;

export function serializeJobResult(result) {
  if (result === null || result === undefined) return null;
  const context = result.context && typeof result.context === 'object' ? result.context : result;
  const rezultEntries = Object.entries(context).filter(([key, value]) => (
    REZULT_KEY_PATTERN.test(key) && value !== null && typeof value === 'object' && !Array.isArray(value)
  ));
  const artifacts = (Array.isArray(result.artifacts) ? result.artifacts : [])
    .map((artifact) => typeof artifact === 'string' ? artifact : artifact?.api_url)
    .filter((artifact) => typeof artifact === 'string');
  return { artifacts, ...Object.fromEntries(rezultEntries) };
}
