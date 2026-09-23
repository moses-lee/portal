"use client";

import { useId, useState } from "react";
import DirectoryBrowser from "./DirectoryBrowser";
import ResponsiveDialog from "./ResponsiveDialog";
import { basename } from "./ContextBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type AddProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (input: { path: string; name: string }) => Promise<void>;
};

export default function AddProjectDialog(props: AddProjectDialogProps) {
  if (!props.open) return null;
  return <ProjectForm {...props} />;
}

function ProjectForm({ open, onClose, onAdd }: AddProjectDialogProps) {
  const [path, setPath] = useState("");
  const [customName, setCustomName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const name = customName ?? (path ? basename(path) : "");
  const canAdd = !pending && !!path && !!name.trim();
  const submit = async () => {
    if (!canAdd) return;
    setPending(true);
    setError(null);
    try {
      await onAdd({ path, name: name.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the project.");
    } finally {
      setPending(false);
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !pending) onClose();
      }}
      title="Add a project"
      description="Choose the folder your agents will work in."
    >
      <div className="mb-5 max-h-[40dvh] overflow-y-auto">
        <DirectoryBrowser value={path} onChange={setPath} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <div className="space-y-2">
          <label htmlFor={nameId} className="text-xs font-medium">
            Project name
          </label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setCustomName(e.target.value)}
            disabled={pending}
            placeholder="My project"
            className="h-10"
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canAdd}>
            {pending ? "Adding…" : "Add project"}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  );
}
