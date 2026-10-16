"use client";

/** Saves a JSON string as a file in the browser. */
export function DownloadJson({ json, fileName }: { json: string; fileName: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button type="button" onClick={download} className="text-sm font-medium text-primary hover:underline">
      Download JSON
    </button>
  );
}
