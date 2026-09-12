(() => {
  const root = globalThis;
  const ns = root.Echo360Translator = root.Echo360Translator || {};
  const rawApi = root.browser || root.chrome;

  if (!rawApi) {
    throw new Error("WebExtension API is not available");
  }

  const usesPromiseApi = !!root.browser && rawApi === root.browser;

  function lastRuntimeError() {
    return rawApi.runtime?.lastError || root.chrome?.runtime?.lastError || null;
  }

  function toApiError(errorLike, code, fallbackMessage = "扩展 API 调用失败") {
    const isGeneric = (value) => ns.errorUtils?.isGenericCode?.(value) ||
      ["", "ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"].includes(String(value ?? "").trim().toUpperCase());
    const isWrapper = (value) => ns.errorUtils?.isWrapperCode?.(value) || [
      "BACKEND_REQUEST_ERROR",
      "BACKEND_NETWORK_ERROR",
      "RUNTIME_MESSAGE_ERROR",
      "DIRECT_JOB_CREATE_FAILED",
      "DIRECT_JOB_READ_FAILED",
      "JOB_FAILED_UNCLASSIFIED",
      "TRANSLATOR_PROCESS_FAILED",
      "INTERNAL_ERROR",
      "PROVIDER_REQUEST_FAILED",
      "INVALID_BACKEND_RESPONSE",
    ].includes(String(value ?? "").trim().toUpperCase());
    const rawMessage = typeof errorLike === "object" && errorLike
      ? (errorLike.message || errorLike.error || errorLike.detail || errorLike.title)
      : errorLike;
    const error = errorLike instanceof Error
      ? errorLike
      : new Error(String(rawMessage || fallbackMessage));
    if (!error.message) error.message = fallbackMessage;
    if (errorLike && typeof errorLike === "object") Object.assign(error, errorLike);
    const inferredCode = ns.errorUtils?.getErrorCode?.(errorLike);
    const candidates = [
      inferredCode,
      errorLike?.error_detail?.error_code,
      errorLike?.error_detail?.code,
      errorLike?.error_code,
      errorLike?.errorCode,
      error.code,
      code,
    ].filter(Boolean);
    error.code = candidates.find((candidate) => !isGeneric(candidate) && !isWrapper(candidate)) ||
      candidates.find((candidate) => !isGeneric(candidate)) || code;
    return error;
  }

  function errorResponse(error, code = "RUNTIME_MESSAGE_ERROR") {
    const normalized = toApiError(error, code);
    const serialized = root.Echo360Translator?.errorUtils?.serializeError?.(normalized, {
      phase: normalized.phase || "backend",
    }) || {
      code: normalized.code,
      status: Number.isInteger(Number(normalized.status ?? normalized.statusCode)) &&
        Number(normalized.status ?? normalized.statusCode) >= 100 &&
        Number(normalized.status ?? normalized.statusCode) <= 599
        ? Number(normalized.status ?? normalized.statusCode)
        : null,
      message: normalized.message,
      phase: normalized.phase || "backend",
    };
    // The structured serializer is authoritative. Using the pre-normalized
    // adapter fields here could return `error_code=TRANSLATION_ERROR` while
    // `error_detail.code=HTTP_429`, which makes the next boundary choose the
    // wrong UI diagnosis.
    const responseCode = serialized?.error_code || serialized?.code || normalized.code || code;
    const responseMessage = serialized?.detail || serialized?.message || normalized.message || "扩展 API 调用失败";
    const rawStatus = serialized?.status ?? normalized.status ?? normalized.statusCode;
    const responseStatus = Number.isInteger(Number(rawStatus)) &&
      Number(rawStatus) >= 100 && Number(rawStatus) <= 599
      ? Number(rawStatus)
      : null;
    return {
      ok: false,
      error: responseMessage,
      // Keep both names at this compatibility boundary. Older callers read
      // `error_code`; newer callers and the RFC-style problem serializer read
      // `code`. They must describe the same root diagnosis.
      code: responseCode,
      error_code: responseCode,
      status: responseStatus,
      upstream_status: serialized?.upstream_status ?? null,
      boundary_code: serialized?.boundary_code || null,
      title: serialized?.title || normalized.title || "",
      type: serialized?.type || normalized.type || "",
      phase: serialized?.phase || normalized.phase || "backend",
      error_detail: serialized,
    };
  }

  function callApi(fn, thisArg, args, errorCode = "RUNTIME_MESSAGE_ERROR") {
    if (usesPromiseApi) {
      try {
        return Promise.resolve(fn.apply(thisArg, args)).catch((err) => {
          throw toApiError(err, errorCode);
        });
      } catch (err) {
        return Promise.reject(toApiError(err, errorCode));
      }
    }

    return new Promise((resolve, reject) => {
      try {
        fn.apply(thisArg, [
          ...args,
          (result) => {
            const err = lastRuntimeError();
            if (err) {
              reject(toApiError(err, errorCode));
              return;
            }
            resolve(result);
          },
        ]);
      } catch (err) {
        reject(toApiError(err, errorCode));
      }
    });
  }

  const api = {
    raw: rawApi,
    toError(errorLike, code = "RUNTIME_MESSAGE_ERROR", fallbackMessage = "扩展 API 调用失败") {
      return toApiError(errorLike, code, fallbackMessage);
    },
    runtime: {
      getURL(path) {
        return rawApi.runtime.getURL(path);
      },
      openOptionsPage() {
        if (typeof rawApi.runtime?.openOptionsPage !== "function") return null;
        return callApi(rawApi.runtime.openOptionsPage, rawApi.runtime, [], "RUNTIME_MESSAGE_ERROR");
      },
      sendMessage(message) {
        return callApi(rawApi.runtime.sendMessage, rawApi.runtime, [message], "RUNTIME_MESSAGE_ERROR");
      },
      addOnMessageListener(listener) {
        if (usesPromiseApi) {
          rawApi.runtime.onMessage.addListener((message, sender) => {
            try {
              const result = listener(message, sender);
              return result && typeof result.then === "function"
                ? result.catch((err) => errorResponse(err))
                : result;
            } catch (err) {
              return errorResponse(err);
            }
          });
          return;
        }

        rawApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
          let result;
          try {
            result = listener(message, sender);
          } catch (err) {
            sendResponse(errorResponse(err));
            return false;
          }

          if (result && typeof result.then === "function") {
            result
              .then((response) => sendResponse(response))
              .catch((err) => sendResponse(errorResponse(err)));
            return true;
          }

          if (typeof result !== "undefined") {
            sendResponse(result);
          }
          return false;
        });
      },
    },
    tabs: {
      create(createProperties) {
        if (typeof rawApi.tabs?.create !== "function") {
          return Promise.reject(toApiError("tabs.create is unavailable", "RUNTIME_MESSAGE_ERROR"));
        }
        return callApi(rawApi.tabs.create, rawApi.tabs, [createProperties], "RUNTIME_MESSAGE_ERROR");
      },
      remove(tabId) {
        if (typeof rawApi.tabs?.remove !== "function") return Promise.resolve();
        return callApi(rawApi.tabs.remove, rawApi.tabs, [tabId], "RUNTIME_MESSAGE_ERROR");
      },
    },
    permissions: {
      contains(permissions) {
        if (typeof rawApi.permissions?.contains !== "function") return Promise.resolve(false);
        return callApi(rawApi.permissions.contains, rawApi.permissions, [permissions], "PERMISSION_CHECK_FAILED");
      },
      request(permissions) {
        if (typeof rawApi.permissions?.request !== "function") {
          return Promise.reject(toApiError("permissions.request is unavailable", "BACKEND_PERMISSION_DENIED"));
        }
        return callApi(rawApi.permissions.request, rawApi.permissions, [permissions], "BACKEND_PERMISSION_DENIED");
      },
    },
    storage: {
      local: {
        get(keys) {
          return callApi(rawApi.storage.local.get, rawApi.storage.local, [keys], "STORAGE_ERROR");
        },
        set(items) {
          return callApi(rawApi.storage.local.set, rawApi.storage.local, [items], "STORAGE_ERROR");
        },
        remove(keys) {
          return callApi(rawApi.storage.local.remove, rawApi.storage.local, [keys], "STORAGE_ERROR");
        },
      },
      // storage.onChanged is a plain event (not callback/promise-based) on both
      // Chrome and Firefox, so it can be wired up directly without callApi().
      onChanged: {
        addListener(listener) {
          rawApi.storage.onChanged.addListener(listener);
        },
        removeListener(listener) {
          rawApi.storage.onChanged.removeListener(listener);
        },
      },
    },
  };

  ns.browserApi = api;
  root.Echo360ExtensionApi = api;
})();
