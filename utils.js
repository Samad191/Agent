export function extractSummaryText(obj) {
  return (
    obj.description ||
    obj.snippet ||
    obj.title ||
    obj.content ||
    obj.summary ||
    "No usable text found."
  );
}