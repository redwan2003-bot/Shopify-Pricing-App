// Node auto-detects `.ts`/`.mts`/`.cts` as type-stripped ESM but not `.tsx` (since tsx
// usually needs a real JSX transform). This project's route files have no JSX in the
// action-only ones we need to import for verification, so it's safe to just force the
// type-stripping format for `.tsx` too.
export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx")) {
    return nextLoad(url, { ...context, format: "module-typescript" });
  }
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      for (const ext of [".ts", ".tsx"]) {
        try {
          return await nextResolve(specifier + ext, context);
        } catch {
          // try next extension
        }
      }
    }
    throw err;
  }
}
