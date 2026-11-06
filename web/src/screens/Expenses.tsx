import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useWork, can, fmtDay, money } from '../store';
import { api } from '../api';
import { act, download, fileToBase64, useLoad, Loading, Page, Table, Tag, FormDialog, statusTone, human } from '../kit';

/** Expenses: receipts and mileage, sent for approval, then reimbursed (untaxed) in the next pay run. */
export function Expenses() {
  const { me, people } = useWork();
  const admin = can(me, 'payroll');
  const { data, error, reload } = useLoad<any>('/v1/expenses');
  const [adding, setAdding] = useState<null | 'receipt' | 'mileage'>(null);
  const [file, setFile] = useState<File | null>(null);
  if (!data) return <Page title="Expenses"><Loading error={error} /></Page>;
  return (
    <Page
      title="Expenses"
      lead={`Approved expenses are paid back in the next pay run, not taxed.${data.mileageRateCents ? ` Mileage: ${money(data.mileageRateCents)} a mile.` : ' Set the mileage rate in settings to claim miles.'}`}
      actions={
        <>
          <button className="btn" onClick={() => setAdding('mileage')} disabled={!data.mileageRateCents}>
            Claim mileage
          </button>
          <button className="btn primary" onClick={() => setAdding('receipt')}>
            <Plus size={15} /> Add a receipt
          </button>
        </>
      }
    >
      <Table
        cols={[
          { key: 'personName', label: 'Person' },
          { key: 'date', label: 'Date', render: (e: any) => fmtDay(e.date) },
          { key: 'category', label: 'What', render: (e: any) => `${e.category}${e.description ? ` · ${e.description}` : ''}${e.miles ? ` · ${e.miles} mi` : ''}` },
          { key: 'amountCents', label: 'Amount', money: true },
          { key: 'status', label: 'Status', render: (e: any) => <Tag tone={statusTone(e.status)}>{human(e.status)}</Tag> },
          {
            key: 'act',
            label: '',
            render: (e: any) => (
              <div className="pr-row" style={{ margin: 0 }}>
                {e.receiptId && <button className="btn sm" onClick={() => download(`/v1/documents/${e.receiptId}/download`)}>Receipt</button>}
                {e.status === 'draft' && (
                  <>
                    <button className="btn sm primary" onClick={async () => (await act(api('POST', `/v1/expenses/${e.id}/submit`), 'Sent for approval.')) && reload()}>Send</button>
                    <button className="btn sm" onClick={async () => (await act(api('POST', `/v1/expenses/${e.id}/delete`), 'Deleted.')) && reload()}>Delete</button>
                  </>
                )}
              </div>
            )
          }
        ]}
        rows={data.expenses}
        empty="No expenses yet."
      />
      {adding && (
        <FormDialog
          title={adding === 'mileage' ? 'Claim mileage' : 'Add a receipt'}
          onClose={() => (setAdding(null), setFile(null))}
          initial={{ personId: me?.id, date: new Date().toISOString().slice(0, 10), category: adding === 'mileage' ? 'Mileage' : data.categories[0] }}
          fields={[
            ...(admin ? [{ name: 'personId', label: 'For', type: 'select' as const, required: true, options: people.map((p) => ({ value: p.id, label: p.name })) }] : []),
            { name: 'date', label: 'Date', type: 'date', required: true },
            ...(adding === 'mileage' ? [{ name: 'miles', label: 'Miles', type: 'number' as const, required: true }] : [{ name: 'amountCents', label: 'Amount', type: 'money' as const, required: true }]),
            { name: 'category', label: 'Category', type: 'select', required: true, options: data.categories.map((c: string) => ({ value: c, label: c })) },
            { name: 'description', label: 'What for' }
          ]}
          extra={
            adding === 'receipt' && (
              <label className="pr-field">
                <span>Receipt (photo or PDF)</span>
                <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            )
          }
          submit="Save as draft"
          onSubmit={async (v) => {
            const receipt = file ? { filename: file.name, mime: file.type || 'application/octet-stream', contentBase64: await fileToBase64(file) } : undefined;
            if (await act(api('POST', '/v1/expenses', { ...v, kind: adding, receipt }), 'Saved. Send it for approval when ready.')) {
              setAdding(null);
              setFile(null);
              reload();
            }
          }}
        />
      )}
    </Page>
  );
}
