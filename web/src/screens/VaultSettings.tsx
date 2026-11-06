import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useWork, can, money } from '../store';
import { api } from '../api';
import { act, useLoad, Loading, Page, Table, Tag, Form, FormDialog } from '../kit';

/** The vault (who can sign in, the passphrase, the Hub address) and org-wide payroll settings. */
export function VaultSettings() {
  const { me, mode, people } = useWork();
  const owner = can(me, 'owner');
  const settings = useLoad<any>('/v1/org/settings');
  const users = useLoad<any>(mode === 'vault' ? '/v1/vault/users' : null);
  const [dlg, setDlg] = useState<null | 'pass' | 'local' | 'user' | 'hub'>(null);
  return (
    <Page title={mode === 'vault' ? 'Vault and settings' : 'Payroll settings'}>
      {mode === 'vault' && (
        <section className="pr-section">
          <h2>The vault</h2>
          <p className="muted">SSNs, bank details, tax forms and documents are encrypted (AES-256-GCM) with a key made from the vault passphrase. The key is only in memory while the vault is open. Payroll data never goes to the Hub.</p>
          <div className="pr-row">
            <button className="btn" onClick={() => setDlg('pass')}>
              <Lock size={15} /> Change the passphrase
            </button>
            <button className="btn" onClick={() => setDlg('local')}>
              Local password (for when the Hub is down)
            </button>
            {owner && (
              <button className="btn" onClick={() => setDlg('hub')}>
                Kea Hub address
              </button>
            )}
          </div>
          <h3 className="work-h2">Who can sign in</h3>
          {!users.data ? (
            <Loading error={users.error} />
          ) : (
            <>
              <p className="muted small">Kea Hub: {users.data.hubUrl || 'not set'}</p>
              <Table
                cols={[
                  { key: 'name', label: 'Person' },
                  { key: 'email', label: 'Email' },
                  { key: 'hubLinked', label: 'Kea Hub', render: (u: any) => (u.hubLinked ? <Tag tone="ok">Linked</Tag> : 'Links at first sign-in') },
                  { key: 'localPassword', label: 'Local password', render: (u: any) => (u.localPassword ? 'Set' : '—') },
                  { key: 'lastLogin', label: 'Last sign-in', render: (u: any) => (u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '—') },
                  ...(owner ? [{ key: 'rm', label: '', render: (u: any) => (u.personId !== me?.id ? <button className="btn sm" onClick={async () => (await act(api('POST', `/v1/vault/users/${u.id}/delete`), 'Removed.')) && users.reload()}>Remove</button> : null) }] : [])
                ]}
                rows={users.data.users}
              />
              {owner && (
                <button className="btn" onClick={() => setDlg('user')}>
                  Let someone else sign in
                </button>
              )}
            </>
          )}
        </section>
      )}
      <section className="pr-section">
        <h2>Payroll settings</h2>
        {!settings.data ? (
          <Loading error={settings.error} />
        ) : (
          <Form
            key={JSON.stringify(settings.data.settings)}
            initial={{
              ...settings.data.org,
              mileageRateCents: settings.data.settings.mileageRateCents,
              receiptRequiredCents: settings.data.settings.receiptRequiredCents ?? 7500,
              groupHealthPlan: settings.data.settings.cobra?.groupHealthPlan,
              stateContinuation: settings.data.settings.cobra?.stateContinuation,
              worksiteEmployees: settings.data.settings.fmla?.worksiteEmployees,
              ale: settings.data.settings.aca?.ale,
              expenseCategories: (settings.data.settings.expenseCategories || []).join(', '),
              offerTemplate: settings.data.settings.offerTemplate
            }}
            fields={[
              { name: 'name', label: 'Organization name', required: true },
              { name: 'mileageRateCents', label: 'Mileage rate (per mile)', type: 'money', help: 'Set your own rate; KeaS doesn’t assume one.' },
              { name: 'groupHealthPlan', label: 'We have a group health plan (COBRA reminders)', type: 'checkbox' },
              { name: 'ale', label: 'We’re an applicable large employer (ACA forms)', type: 'checkbox' },
              { name: 'state', label: 'State (two letters)', advanced: true },
              { name: 'futaExempt', label: '501(c)(3): exempt from FUTA', type: 'checkbox', advanced: true },
              { name: 'sutaRate', label: 'State unemployment rate (for example 0.0305)', type: 'number', step: '0.0001', advanced: true },
              { name: 'receiptRequiredCents', label: 'Receipts needed from', type: 'money', advanced: true },
              { name: 'expenseCategories', label: 'Expense categories (comma-separated)', advanced: true },
              { name: 'stateContinuation', label: 'A state continuation law applies to us', type: 'checkbox', advanced: true },
              { name: 'worksiteEmployees', label: 'Employees within 75 miles (FMLA; empty = everyone here)', type: 'number', advanced: true },
              { name: 'offerTemplate', label: 'Offer letter template', type: 'textarea', advanced: true }
            ]}
            onSubmit={async (v) => {
              await act(
                api('POST', '/v1/org/settings', {
                  name: v.name,
                  state: v.state,
                  futaExempt: v.futaExempt,
                  sutaRate: v.sutaRate,
                  mileageRateCents: v.mileageRateCents,
                  receiptRequiredCents: v.receiptRequiredCents ?? 0,
                  expenseCategories: String(v.expenseCategories || '').split(',').map((s) => s.trim()).filter(Boolean),
                  cobra: { groupHealthPlan: v.groupHealthPlan, stateContinuation: v.stateContinuation },
                  fmla: { worksiteEmployees: v.worksiteEmployees },
                  aca: { ale: v.ale },
                  offerTemplate: v.offerTemplate
                }),
                'Settings saved.'
              );
              settings.reload();
            }}
          />
        )}
        {settings.data?.settings?.mileageRateCents ? <p className="muted small">Mileage is paid at {money(settings.data.settings.mileageRateCents)} a mile.</p> : null}
      </section>
      {dlg === 'pass' && (
        <FormDialog
          title="Change the vault passphrase"
          onClose={() => setDlg(null)}
          fields={[
            { name: 'current', label: 'Current passphrase', type: 'password', required: true },
            { name: 'next', label: 'New passphrase (12+ characters)', type: 'password', required: true },
            { name: 'next2', label: 'New passphrase again', type: 'password', required: true }
          ]}
          submit="Change and re-encrypt"
          onSubmit={async (v) => {
            if (v.next !== v.next2) return;
            (await act(api('POST', '/v1/vault/passphrase', { current: v.current, next: v.next }), 'Passphrase changed; everything was re-encrypted.')) && setDlg(null);
          }}
        />
      )}
      {dlg === 'local' && (
        <FormDialog
          title="Local password"
          onClose={() => setDlg(null)}
          fields={[{ name: 'password', label: 'Password for signing in when the Hub can’t be reached (10+ characters)', type: 'password', required: true }]}
          onSubmit={async (v) => (await act(api('POST', '/v1/vault/local-password', v), 'Saved.')) && (setDlg(null), users.reload())}
        />
      )}
      {dlg === 'hub' && (
        <FormDialog
          title="Kea Hub address"
          onClose={() => setDlg(null)}
          initial={{ hubUrl: users.data?.hubUrl || '' }}
          fields={[{ name: 'hubUrl', label: 'Address', placeholder: 'https://…' }]}
          onSubmit={async (v) => (await act(api('POST', '/v1/vault/hub-url', { hubUrl: v.hubUrl || '' }), 'Saved.')) && (setDlg(null), users.reload())}
        />
      )}
      {dlg === 'user' && (
        <FormDialog
          title="Let someone else sign in"
          onClose={() => setDlg(null)}
          fields={[
            { name: 'personId', label: 'Person', type: 'select', required: true, options: people.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'email', label: 'Their Kea Hub email', type: 'email', required: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/vault/users', v), 'They can sign in with their Kea Hub account and the passphrase.')) && (setDlg(null), users.reload())}
        />
      )}
    </Page>
  );
}
