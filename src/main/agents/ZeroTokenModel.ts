function providerLabel(modelId: string): string {
  const provider = modelId.split("/", 1)[0]?.trim();
  if (!provider) return "WebModel";
  const label = provider
    .replace(/[-_]+web$/i, " Web")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return label.replace(/^Deepseek\b/i, "DeepSeek");
}

export function zeroTokenModelLabel(model: string | null | undefined): string {
  return model?.trim() ? providerLabel(model) : "WebModel";
}
