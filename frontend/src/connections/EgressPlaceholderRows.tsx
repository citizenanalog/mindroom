import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BROKERED_PLACEHOLDER,
  type EditorContext,
  type EgressServiceForm,
  type PlaceholderForm,
} from "./egressServiceForm";
import {
  operatorPlaceholderHint,
  personalPlaceholderHint,
} from "./egressPlaceholderRules";
import { configPlaceholderWarning } from "./egressServiceNotes";
import { placeholderField } from "./egressServiceValidation";
import { errorClass, warningClass } from "./EgressRuleFields";
import type { EgressPlaceholderValidation, EgressPreset } from "./types";

/**
 * The placeholder variables of a service: what they are for, the rules for
 * their names, one row each with its problem or warning, and the warnings for
 * the variables its preset brings.
 */
export function PlaceholderRows({
  form,
  set,
  problemAt,
  disabled,
  context,
  preset,
  validation,
  configPlaceholders,
}: {
  form: EgressServiceForm;
  set: (changes: Partial<EgressServiceForm>) => void;
  problemAt: (field: string) => string | undefined;
  disabled: boolean;
  context: EditorContext;
  preset: EgressPreset | undefined;
  /** The server's placeholder rules the hint spells out; `null` until they load or when the server sends none. */
  validation: EgressPlaceholderValidation | null;
  /** Variable name to the display name of the administrator's service that sets it. */
  configPlaceholders: Readonly<Record<string, string>>;
}) {
  const id = useId();
  const setPlaceholder = (index: number, placeholder: PlaceholderForm) =>
    set({
      placeholders: form.placeholders.map((existing, i) =>
        i === index ? placeholder : existing,
      ),
    });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Placeholder variables</h4>
        <p className="text-xs text-muted-foreground">
          Environment variables set in the agent's sandbox so tools find a key
          to send. Use a fixed value such as {BROKERED_PLACEHOLDER}; the broker
          swaps in the real key. Placeholders are set only while this service
          has a key or a connected account.
          {preset
            ? form.explicitlyEmpty.placeholders
              ? ` This service sets none, which drops the placeholders of the ${preset.display_name} preset.`
              : ` Leave the list empty to use the placeholders of the ${preset.display_name} preset.`
            : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          {context === "personal"
            ? personalPlaceholderHint(validation)
            : operatorPlaceholderHint(validation)}
        </p>
      </div>
      {form.placeholders.map((placeholder, index) => {
        const nameError = problemAt(placeholderField(index, "name"));
        const valueError = problemAt(placeholderField(index, "value"));
        const warning = nameError
          ? null
          : configPlaceholderWarning(placeholder.name, configPlaceholders);
        const nameNoteId = `${id}-placeholder-${index}-name-note`;
        const valueNoteId = `${id}-placeholder-${index}-value-note`;
        return (
          <div key={index} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Placeholder ${index + 1} name`}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError || warning ? nameNoteId : undefined}
                placeholder="MY_API_KEY"
                className="h-9 w-56 font-mono text-xs aria-invalid:border-destructive"
                value={placeholder.name}
                disabled={disabled}
                onChange={(event) =>
                  setPlaceholder(index, {
                    ...placeholder,
                    name: event.target.value,
                  })
                }
              />
              <Input
                aria-label={`Placeholder ${index + 1} value`}
                aria-invalid={valueError ? true : undefined}
                aria-describedby={valueError ? valueNoteId : undefined}
                className="h-9 w-56 font-mono text-xs aria-invalid:border-destructive"
                value={placeholder.value}
                disabled={disabled}
                onChange={(event) =>
                  setPlaceholder(index, {
                    ...placeholder,
                    value: event.target.value,
                  })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove placeholder ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  set({
                    placeholders: form.placeholders.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
            {nameError && (
              <p id={nameNoteId} className={errorClass}>
                {nameError}
              </p>
            )}
            {warning && (
              <p id={nameNoteId} className={warningClass}>
                {warning}
              </p>
            )}
            {valueError && (
              <p id={valueNoteId} className={errorClass}>
                {valueError}
              </p>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          set({
            placeholders: [
              ...form.placeholders,
              { name: "", value: BROKERED_PLACEHOLDER },
            ],
          })
        }
      >
        Add placeholder
      </Button>
    </div>
  );
}
