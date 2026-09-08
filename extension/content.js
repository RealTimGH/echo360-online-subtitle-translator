(() => {
  const ns = window.Echo360Translator;
  const assessmentGuard = window.Echo360AssessmentGuard;

  async function start() {
    const allowed = assessmentGuard?.isAllowedDocument?.() ||
      await assessmentGuard?.verifyAllowedDocument?.();
    if (!allowed) return;

    console.log("[echo360-translator] content script loaded:", location.href);

    Promise.resolve(ns.controller.init()).catch((error) => {
      console.error(
        "[echo360-translator][content] initialization failed",
        ns.errorUtils?.serializeError?.(error, { phase: "initialization" }) || error
      );
      ns.ui?.ensurePanel?.();
      ns.ui?.showError?.(error, {
        phase: "initialization",
        onCancel: () => ns.ui?.clearError?.(),
      });
    });
  }

  void start();
})();
