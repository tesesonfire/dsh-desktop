export interface ErrorPanelProps {
  title: string;
  message: string;
  hint?: string;
}

/** Plain error card. Copy is passed in by the caller; layout is bilingual-free. */
export function ErrorPanel({ title, message, hint }: ErrorPanelProps) {
  return (
    <section className="dsh-error" role="alert">
      <h2 className="dsh-error__title">{title}</h2>
      <p className="dsh-error__message">{message}</p>
      {hint ? <p className="dsh-error__hint">提示 / Hint：{hint}</p> : null}
    </section>
  );
}
