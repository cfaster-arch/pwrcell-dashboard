import { useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDisplaySettings } from "./display-settings-context";

const COLOR_PRESETS = ["#0b0d0c", "#1a2f24", "#1f2a44", "#3a1f2b", "#0e3a3a", "#2b2b2b"];

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="eyebrow mb-2">{label}</p>
      <div className="well flex p-1" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 rounded-[0.3rem] px-2 py-2.5 text-sm font-semibold transition-all duration-150 ease-out",
              "active:scale-[0.97]",
              value === o.value
                ? "bg-solar-dim text-solar shadow-[inset_0_1px_0_rgb(242_234_217/0.08)]"
                : "text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="well flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-transform duration-150 ease-out active:scale-[0.99]"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-xs leading-snug text-subtle">{hint}</span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-solar" : "bg-border",
        )}
      >
        <span
          className={cn(
            "absolute top-1 left-1 size-5 rounded-full bg-bg shadow transition-transform duration-200",
            checked && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
}

export function SettingsPanel() {
  const { settings, update, uploadBackground, removeBackground } = useDisplaySettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [bust, setBust] = useState(0);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    const err = await uploadBackground(file);
    setUploading(false);
    if (err) {
      setUploadError(err);
    } else {
      setBust((b) => b + 1);
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onRemove() {
    await removeBackground();
    setBust((b) => b + 1);
  }

  return (
    <section aria-label="Display settings" className="flex flex-col gap-4 px-2 pt-2 pb-4">
      <div className="border-t border-border pt-4">
        <p className="mb-3 eyebrow">
          Display
        </p>
        <div className="flex flex-col gap-4">
          <Segmented
            label="Theme"
            value={settings.theme}
            onChange={(theme) => void update({ theme })}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
          <Segmented
            label="Display mode"
            value={settings.displayMode}
            onChange={(displayMode) => void update({ displayMode })}
            options={[
              { value: "gauges", label: "Gauges" },
              { value: "tiles", label: "Tiles" },
              { value: "graphs", label: "Graphs" },
              { value: "flow", label: "Flow" },
            ]}
          />
          <Segmented
            label="Night dim"
            value={settings.nightDim ? "on" : "off"}
            onChange={(v) => void update({ nightDim: v === "on" })}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
          <Segmented
            label="Background"
            value={settings.backgroundMode}
            onChange={(backgroundMode) => void update({ backgroundMode })}
            options={[
              { value: "default", label: "Default" },
              { value: "color", label: "Color" },
              { value: "image", label: "Image" },
            ]}
          />

          {settings.backgroundMode === "color" ? (
            <div>
              <p className="mb-1.5 eyebrow">
                Background color
              </p>
              <div className="flex items-center gap-2">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => void update({ backgroundColor: c })}
                    aria-label={`Use ${c} as background`}
                    aria-pressed={settings.backgroundColor.toLowerCase() === c}
                    className={cn(
                      "size-9 rounded-full shadow-[var(--shadow-border)] transition-transform duration-150 ease-out active:scale-95",
                      settings.backgroundColor.toLowerCase() === c &&
                        "ring-2 ring-fg ring-offset-2 ring-offset-surface",
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label
                  className="relative size-9 cursor-pointer overflow-hidden rounded-full shadow-[var(--shadow-border)]"
                  title="Pick a custom color"
                >
                  <span
                    className="absolute inset-0"
                    style={{
                      background:
                        "conic-gradient(#f55,#ff5,#5f5,#5ff,#55f,#f5f,#f55)",
                    }}
                    aria-hidden="true"
                  />
                  <input
                    type="color"
                    value={settings.backgroundColor}
                    onChange={(e) => void update({ backgroundColor: e.target.value })}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Pick a custom background color"
                  />
                </label>
              </div>
            </div>
          ) : null}

          {settings.backgroundMode === "image" ? (
            <div>
              <p className="mb-1.5 eyebrow">
                Background image
              </p>
              {settings.hasBackgroundImage ? (
                <div className="flex flex-col gap-2">
                  <img
                    key={bust}
                    src={`/api/display-background?t=${bust}`}
                    alt="Current background"
                    className="h-24 w-full rounded-lg object-cover shadow-[var(--shadow-border)]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm font-medium text-fg hover:text-fg disabled:opacity-60"
                    >
                      {uploading ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <ImagePlus className="size-4" aria-hidden="true" />
                      )}
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => void onRemove()}
                      disabled={uploading}
                      className="flex items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm font-medium text-muted hover:text-danger disabled:opacity-60"
                      aria-label="Remove background image"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 py-3 text-sm font-medium text-fg disabled:opacity-60"
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <ImagePlus className="size-4" aria-hidden="true" />
                  )}
                  Upload image
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
                aria-label="Upload background image"
              />
              {uploadError ? (
                <p className="mt-1.5 text-xs text-danger">{uploadError}</p>
              ) : (
                <p className="mt-1.5 text-xs text-subtle">PNG, JPG, WebP or GIF up to 8&nbsp;MB.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div className="border-t border-border pt-4">
        <p className="mb-3 eyebrow">
          Extras
        </p>
        <div className="flex flex-col gap-3">
          <Switch
            label="Rate calculations"
            hint="Cost estimates in Graphs view, plus the rate-plan settings below"
            checked={settings.showRates}
            onChange={(showRates) => void update({ showRates })}
          />
          <Switch
            label="Cameras"
            hint="Ring camera feeds on the dashboard, plus camera setup below"
            checked={settings.showCameras}
            onChange={(showCameras) => void update({ showCameras })}
          />
        </div>
      </div>
    </section>
  );
}
