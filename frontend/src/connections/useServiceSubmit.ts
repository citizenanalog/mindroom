import {
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type EditorOptions,
  type EgressServiceForm,
  type ServiceProblem,
  isBasicField,
  serializeService,
  validateService,
} from "./egressServiceModel";
import type { AuthoredEgressService } from "./types";

/** The message of a rejection, or `fallback` when it has none. */
function reasonOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** A problem with no field to show it, or with a field the basic form does not have. */
function needsMoreOptions(problem: ServiceProblem): boolean {
  return problem.field !== "form" && !isBasicField(problem.field);
}

/**
 * Saving and deleting for the editor: validation once the user has tried, the
 * one-step save (the service first, its key second), the confirmations before a
 * save with a wider effect and before a delete, and which invalid field gets
 * focus.
 *
 * A key never goes out for a service whose save failed. When only the key
 * fails, the service stays saved and a retry writes the key alone, unless the
 * service changed meanwhile.
 */
export function useServiceSubmit({
  form,
  options,
  settings,
  service,
  apiKey,
  saveWarning,
  onSave,
  saveKey,
  onSaved,
  onDelete,
  openMoreOptions,
  prepareForm,
}: {
  form: EgressServiceForm;
  options: EditorOptions;
  settings: { editing: boolean; takenNames: readonly string[] };
  /** The service the form opened with, which supplies what the form cannot show. */
  service: AuthoredEgressService | null;
  apiKey: string;
  saveWarning: string | null;
  onSave: (name: string, service: AuthoredEgressService) => Promise<void>;
  saveKey?: (key: string, name: string) => Promise<void>;
  onSaved?: () => void;
  onDelete?: () => Promise<void>;
  /** Show the section that holds a problem the basic form does not. */
  openMoreOptions: () => void;
  /**
   * Called when a save starts, to bring in what the person typed but did not
   * apply yet. Returns the form to save, or `null` when something it holds is
   * wrong, which it shows itself and which stops the save.
   */
  prepareForm?: () => EgressServiceForm | null;
}): {
  formRef: RefObject<HTMLFormElement | null>;
  /** The form's problems, empty until the user has tried to save. */
  problems: ServiceProblem[];
  busy: "save" | "delete" | null;
  serverError: string | null;
  confirmingSave: boolean;
  setConfirmingSave: (confirming: boolean) => void;
  confirmingDelete: boolean;
  setConfirmingDelete: (confirming: boolean) => void;
  /** The service as last written; its name can no longer change. */
  saved: boolean;
  submit: (event: FormEvent) => Promise<void>;
  remove: () => Promise<void>;
} {
  const formRef = useRef<HTMLFormElement>(null);
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);
  // The service as last written, so a retry after a failed key does not write it again.
  const [savedSignature, setSavedSignature] = useState<string | null>(null);

  // After a failed save, the first invalid field in page order gets focus; a
  // problem that no field holds marks its message for focus instead.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current
      ?.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-problem-focus]',
      )
      ?.focus();
  }, [focusRequest]);

  const problems = attempted ? validateService(form, options, settings) : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    setServerError(null);
    const current = prepareForm ? prepareForm() : form;
    if (current === null) {
      setFocusRequest((count) => count + 1);
      return;
    }
    const found = validateService(current, options, settings);
    if (found.length > 0) {
      if (found.some(needsMoreOptions)) openMoreOptions();
      setFocusRequest((count) => count + 1);
      return;
    }
    if (saveWarning && !confirmingSave) {
      setConfirmingSave(true);
      return;
    }
    setConfirmingSave(false);
    setBusy("save");
    const authored = serializeService(current, options, service);
    const signature = JSON.stringify([current.name, authored]);
    try {
      // The service goes first, and the key only after it is written.
      if (signature !== savedSignature) {
        await onSave(current.name, authored);
        setSavedSignature(signature);
      }
    } catch (cause) {
      setServerError(reasonOf(cause, "Could not save the service. Try again."));
      setBusy(null);
      return;
    }
    if (saveKey && apiKey.trim() !== "") {
      try {
        await saveKey(apiKey, current.name);
      } catch (cause) {
        const reason = reasonOf(cause, "Could not save the key.");
        setServerError(
          `The service was saved, but its key was not: ${reason}${reason.endsWith(".") ? "" : "."} Paste the key again and save to retry.`,
        );
        setBusy(null);
        return;
      }
    }
    onSaved?.();
  };

  const remove = async () => {
    if (!onDelete) return;
    setBusy("delete");
    setServerError(null);
    try {
      await onDelete();
    } catch (cause) {
      setServerError(
        reasonOf(cause, "Could not delete the service. Try again."),
      );
      setBusy(null);
      setConfirmingDelete(false);
    }
  };

  return {
    formRef,
    problems,
    busy,
    serverError,
    confirmingSave,
    setConfirmingSave,
    confirmingDelete,
    setConfirmingDelete,
    saved: savedSignature !== null,
    submit,
    remove,
  };
}
