// A crash in one panel costs that panel, not the page: without a boundary React unmounts the whole app on a render
// or effect error. The fallback is a Card with a short message and a Reload button.
import { Component } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { Card, raisedButton } from "./rev5";
import { Button } from "./controls/Button";

type Props = { name: string; children: ReactNode; style?: CSSProperties; resetKey?: unknown };

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error) { console.error(`[${this.props.name}]`, error); }

  // A new area (or run) gets a fresh try.
  componentDidUpdate(prev: Props) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="dr-fallback" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "var(--ground)", ...this.props.style }}>
        <div style={{ width: "100%", maxWidth: 360 }}>
          <Card title={`The ${this.props.name} stopped`}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: "var(--ink-muted)" }}>
                Something went wrong here. The rest of the page still works. Reload to bring it back.
              </p>
              <Button variant="raised" type="button" onClick={() => window.location.reload()} style={{ ...raisedButton, alignSelf: "flex-start", height: 32, padding: "0 12px",
                display: "inline-flex", alignItems: "center", gap: 8, borderRadius: "var(--radius-md)", font: "inherit", fontWeight: 500, cursor: "pointer" }}>
                <ArrowClockwise size={14} weight="bold" aria-hidden="true" />Reload
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }
}
