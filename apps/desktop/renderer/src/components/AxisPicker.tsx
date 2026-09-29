interface Props {
  label: string;
  hint?: string;
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
}

/** 维度 chips 多选器：同维多选、可取消（呼应 docs/01 §3.1 四维派系模型） */
export function AxisPicker({ label, hint, options, value, onChange }: Props) {
  const toggle = (item: string) => {
    onChange(value.includes(item) ? value.filter((v) => v !== item) : [...value, item]);
  };

  return (
    <div className="axis">
      <div className="axis-head">
        <span className="axis-label">{label}</span>
        {hint && <span className="muted">{hint}</span>}
        <span className="spacer" />
        <span className="muted">已选 {value.length}</span>
      </div>
      <div className="chips">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={value.includes(option) ? "chip on" : "chip"}
            onClick={() => toggle(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}