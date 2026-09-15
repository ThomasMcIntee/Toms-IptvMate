type Props = {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: (checked: boolean) => void;
};

export function VisibilityToggle({ checked, label, disabled = false, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`list-visibility-toggle${checked ? " is-on" : ""}`}
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onToggle(!checked);
      }}
    >
      <span aria-hidden="true">{checked ? "On" : "Off"}</span>
    </button>
  );
}
