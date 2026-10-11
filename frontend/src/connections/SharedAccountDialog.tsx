import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHARED_ACCOUNT_TITLE, sharedAccountBody } from "./accountCopy";

/** Asked before connecting an account on a shared agent, since everyone who uses the agent acts as it. */
export function SharedAccountDialog({
  open,
  agent,
  provider,
  onContinue,
  onCancel,
}: {
  open: boolean;
  agent: string;
  provider: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  // The dialog may stay on screen a moment after Continue, so a second click must not go on again.
  const continued = useRef(false);
  useEffect(() => {
    if (open) continued.current = false;
  }, [open]);
  const doContinue = () => {
    if (continued.current) return;
    continued.current = true;
    onContinue();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{SHARED_ACCOUNT_TITLE}</DialogTitle>
          <DialogDescription>
            {sharedAccountBody(agent, provider)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={doContinue}>Continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
