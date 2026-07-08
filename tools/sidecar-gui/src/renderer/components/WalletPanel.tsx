import { fmtCtaz } from "@shared/contracts";
import { useStore } from "../store";

export function WalletPanel(): JSX.Element {
  const wallet = useStore((s) => s.status?.wallet ?? null);

  if (!wallet) {
    return (
      <Card title="Wallet">
        <p className="text-sm text-zinc-500">
          Waiting for{" "}
          <span className="mono">staking_command info</span> — make sure you
          rebuilt zebrad with the sidecar patch and that it's running.
        </p>
      </Card>
    );
  }

  const rows: Array<[string, number, string?]> = [
    ["spendable shielded", wallet.user_shielded_spendable, "text-ok"],
    ["pending shielded", wallet.user_shielded_pending, "text-warn"],
    ["unshielded", wallet.user_unshielded],
    ["total user balance", wallet.user_balance_zats, "text-zinc-100 font-semibold"],
    ["staked", wallet.staked_zats, "text-accent"],
    ["withdrawable", wallet.withdrawable_zats, "text-accent"],
  ];

  return (
    <Card title="Wallet">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, zats, color]) => (
            <tr key={label} className="border-b border-zinc-800/60 last:border-0">
              <td className="py-1.5 text-zinc-400">{label}</td>
              <td className={`py-1.5 text-right mono ${color ?? ""}`}>
                {fmtCtaz(zats)} <span className="text-zinc-500">cTAZ</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
        <Indicator label="actions in-flight" value={wallet.actions_in_flight ?? 0} />
        <Indicator label="bonded" value={wallet.stake_positions_bonded ?? 0} />
        <Indicator label="unbonded" value={wallet.stake_positions_unbonded ?? 0} />
        <Indicator
          label="waiting"
          value={
            (wallet.waiting_for_faucet ? "faucet " : "") +
            (wallet.waiting_for_stake ? "stake" : "") || "—"
          }
        />
      </div>
    </Card>
  );
}

function Indicator(props: { label: string; value: number | string }): JSX.Element {
  return (
    <span>
      {props.label}: <span className="mono">{props.value}</span>
    </span>
  );
}

function Card(props: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold tracking-wide text-zinc-300 mb-3 uppercase">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}
