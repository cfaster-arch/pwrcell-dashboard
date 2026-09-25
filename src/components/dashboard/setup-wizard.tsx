import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, KeyRound } from "lucide-react";
import { useDisplaySettings } from "./display-settings-context";
import type { DisplayMode } from "@/lib/display-settings";
import { cn } from "@/lib/utils";

const MODES: { id: DisplayMode; label: string; hint: string }[] = [
  { id: "gauges", label: "Gauges", hint: "Analog dials" },
  { id: "tiles", label: "Tiles", hint: "Big numbers" },
  { id: "graphs", label: "Graphs", hint: "Charts + history" },
  { id: "flow", label: "Power Flow", hint: "Animated diagram" },
];

export function SetupWizard({
  pwrviewConfigured,
  touLabel,
  onOpenLogin,
}: {
  pwrviewConfigured: boolean;
  touLabel: string | null;
  onOpenLogin: () => void;
}) {
  const { settings, update } = useDisplaySettings();
  const [step, setStep] = useState(0);
  if (settings.setupComplete) return null;

  const finish = () => void update({ setupComplete: true });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="First-time setup">
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl">
        <p className="text-kicker tracking-[0.22em] text-muted uppercase">First-time setup</p>
        <h2 className="mt-1 text-xl font-medium tracking-tight">
          {["Connect PWRview", "Rate plan", "Cameras", "Display mode"][step]}
        </h2>

        {step === 0 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed text-muted">
              This dashboard reads your Generac system through your PWRview
              account. Your login stays on this server — it never leaves it.
            </p>
            {pwrviewConfigured ? (
              <p className="flex items-center gap-2 text-sm font-medium text-ok">
                <Check className="size-4" /> Connected — live data incoming.
              </p>
            ) : (
              <button
                onClick={onOpenLogin}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2 px-4 py-3 text-sm font-medium hover:bg-surface"
              >
                <KeyRound className="size-4" /> Enter PWRview login
              </button>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed text-muted">
              Cost estimates use this rate plan. It's a starting point —
              check it against the electric bill and correct it in Settings
              if anything differs.
            </p>
            <p className="rounded-lg bg-surface-2 px-4 py-3 text-sm font-medium">
              {touLabel ?? "Standard residential time-of-use"}
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm leading-relaxed text-muted">
              Ring cameras are optional. When you're ready, open the menu
              (top left) → <span className="font-medium text-fg">Cameras</span>,
              sign in to Ring, and pick which cameras show on the dashboard.
              You can skip this entirely for now.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => void update({ displayMode: m.id })}
                className={cn(
                  "rounded-lg border-2 px-3 py-3 text-left",
                  settings.displayMode === m.id
                    ? "border-ok bg-surface-2"
                    : "border-transparent bg-surface-2/50 hover:bg-surface-2",
                )}
              >
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {settings.displayMode === m.id && <Check className="size-4 text-ok" />}
                  {m.label}
                </p>
                <p className="mt-0.5 text-xs text-muted">{m.hint}</p>
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-muted hover:text-fg disabled:opacity-30"
          >
            <ArrowLeft className="size-4" /> Back
          </button>
          <p className="text-xs text-subtle">{step + 1} of 4</p>
          {step < 3 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="flex items-center gap-1 rounded-lg bg-surface-2 px-4 py-2 text-sm font-medium hover:bg-surface"
            >
              Next <ArrowRight className="size-4" />
            </button>
          ) : (
            <button
              onClick={finish}
              className="flex items-center gap-1 rounded-lg bg-ok/20 px-4 py-2 text-sm font-medium text-ok hover:bg-ok/30"
            >
              <Check className="size-4" /> Done
            </button>
          )}
        </div>
        <button onClick={finish} className="mt-3 w-full text-center text-xs text-subtle hover:text-muted">
          Skip setup
        </button>
      </div>
    </div>
  );
}
