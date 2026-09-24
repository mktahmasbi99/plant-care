export type PwaInstallState = {
  canPrompt: boolean;
  install: () => Promise<void>;
  installed: boolean;
  isIos: boolean;
  isSecure: boolean;
};

export function InstallAppPanel({ state }: { state: PwaInstallState }) {
  let content;
  if (state.installed) {
    content = <p className="muted" role="status">Installed on this device.</p>;
  } else if (!state.isSecure) {
    content = <p className="muted">Installation requires an HTTPS address. This HTTP address can still be used in a browser.</p>;
  } else if (state.canPrompt) {
    content = <>
      <button className="water" onClick={() => void state.install()}>Install Plant Care</button>
      <p className="muted">Opens the browser’s installation confirmation.</p>
    </>;
  } else if (state.isIos) {
    content = <p className="muted">In Safari, tap Share, then Add to Home Screen.</p>;
  } else {
    content = <p className="muted">Use your browser menu to install this app. If Install is not available yet, keep this page open briefly and try again.</p>;
  }

  return <section className="panel settings install-settings"><h2>Install app</h2>{content}</section>;
}
