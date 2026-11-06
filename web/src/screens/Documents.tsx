import { useState } from 'react';
import { Upload } from 'lucide-react';
import { useWork, fmtDay } from '../store';
import { api } from '../api';
import { ask } from '../ui';
import { act, download, fileToBase64, useLoad, Loading, Page, Table, Tabs, Tag, FormDialog, ESign, human } from '../kit';

type Tab = 'cabinet' | 'retention';

/** Employee documents: a file cabinet per person (encrypted in the vault), e-signing, and retention with legal holds. */
export function Documents() {
  const [tab, setTab] = useState<Tab>('cabinet');
  return (
    <Page title="Documents" lead="Files are encrypted in the vault. Retention rules say how long each kind is kept; a legal hold keeps a file no matter what.">
      <Tabs tabs={[{ id: 'cabinet', label: 'File cabinet' }, { id: 'retention', label: 'Retention' }]} value={tab} onChange={setTab} />
      {tab === 'cabinet' ? <Cabinet /> : <Retention />}
    </Page>
  );
}

function Cabinet() {
  const { people } = useWork();
  const [personId, setPersonId] = useState<string>('');
  const { data, error, reload } = useLoad<any>(`/v1/documents${personId ? `?personId=${personId}` : ''}`, [personId]);
  const [up, setUp] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sign, setSign] = useState<any | null>(null);
  const name = (id: string | null) => (id ? people.find((p) => p.id === id)?.name || '—' : 'Organization');
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="pr-row">
        <select className="pr-input" value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Whose documents">
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={() => setUp(true)}>
          <Upload size={15} /> Add a file
        </button>
      </div>
      <Table
        cols={[
          { key: 'title', label: 'Document', render: (d: any) => <>{d.title} {d.legalHold && <Tag tone="warn">Legal hold</Tag>} {d.needsSignature && <Tag tone="warn">Needs signature</Tag>} {d.signature && <Tag tone="ok">Signed</Tag>}</> },
          { key: 'personId', label: 'Person', render: (d: any) => name(d.personId) },
          { key: 'category', label: 'Kind', render: (d: any) => human(d.category) },
          { key: 'createdAt', label: 'Added', render: (d: any) => fmtDay(d.createdAt) },
          { key: 'retainUntil', label: 'Keep until', render: (d: any) => (d.retainUntil ? fmtDay(d.retainUntil) : 'Keep') },
          {
            key: 'act',
            label: '',
            render: (d: any) => (
              <div className="pr-row" style={{ margin: 0 }}>
                <button className="btn sm" onClick={() => download(`/v1/documents/${d.id}/download`)}>Open</button>
                {d.personId && !d.signature && <button className="btn sm" onClick={() => setSign(d)}>Sign</button>}
                <button className="btn sm" onClick={async () => (await act(api('POST', `/v1/documents/${d.id}/hold`, { hold: !d.legalHold }), d.legalHold ? 'Hold released.' : 'On legal hold.')) && reload()}>
                  {d.legalHold ? 'Release hold' : 'Hold'}
                </button>
              </div>
            )
          }
        ]}
        rows={data.documents}
        empty="No documents."
      />
      {up && (
        <FormDialog
          title="Add a file"
          onClose={() => (setUp(false), setFile(null))}
          initial={{ personId, category: 'other' }}
          fields={[
            { name: 'title', label: 'Title', required: true },
            { name: 'personId', label: 'Person', type: 'select', options: people.map((p) => ({ value: p.id, label: p.name })) },
            { name: 'category', label: 'Kind', type: 'select', required: true, options: data.categories.map((c: string) => ({ value: c, label: human(c) })) },
            { name: 'needsSignature', label: 'The person needs to sign it', type: 'checkbox', advanced: true }
          ]}
          extra={
            <label className="pr-field">
              <span>File (up to 8 MB)</span>
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
          }
          submit="Upload"
          onSubmit={async (v) => {
            if (!file) return;
            if (await act(api('POST', '/v1/documents', { ...v, filename: file.name, mime: file.type || 'application/octet-stream', contentBase64: await fileToBase64(file) }), 'Uploaded.')) {
              setUp(false);
              setFile(null);
              reload();
            }
          }}
        />
      )}
      {sign && (
        <FormDialog
          title={`Sign: ${sign.title}`}
          onClose={() => setSign(null)}
          fields={[]}
          submit="Close"
          onSubmit={() => setSign(null)}
          extra={<ESign name={name(sign.personId)} onSign={async (typedName) => (await act(api('POST', `/v1/documents/${sign.id}/sign`, { typedName, consent: true }), 'Signed.')) && (setSign(null), reload())} />}
        />
      )}
    </>
  );
}

function Retention() {
  const { data, error, reload } = useLoad<any>('/v1/retention-rules');
  const due = useLoad<any>('/v1/documents/purge-due');
  const [edit, setEdit] = useState<any | null>(null);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="pr-row">
        <button className="btn" onClick={async () => (await act(api('POST', '/v1/retention-rules/defaults'), 'Added the rules from the labor tables.')) && reload()}>
          Use the labor tables’ rules
        </button>
        <button className="btn" onClick={() => setEdit({ category: 'other' })}>
          Add a rule
        </button>
      </div>
      <Table
        cols={[
          { key: 'category', label: 'Kind', render: (r: any) => human(r.category) },
          { key: 'yearsAfterCreated', label: 'Years after the document', render: (r: any) => r.yearsAfterCreated ?? '—' },
          { key: 'yearsAfterTermination', label: 'Years after the person leaves', render: (r: any) => r.yearsAfterTermination ?? '—' },
          { key: 'note', label: 'Note' }
        ]}
        rows={data.rules}
        onRow={setEdit}
        empty="No rules: every file is kept."
      />
      <h2 className="work-h2">Past their keep-until date</h2>
      <Table
        cols={[
          { key: 'title', label: 'Document' },
          { key: 'category', label: 'Kind', render: (d: any) => human(d.category) },
          { key: 'retainUntil', label: 'Keep until', render: (d: any) => fmtDay(d.retainUntil) }
        ]}
        rows={due.data?.documents || []}
        empty="Nothing is due to be deleted."
      />
      {due.data?.documents?.length > 0 && (
        <button
          className="btn"
          onClick={async () => {
            if ((await ask('Delete these files for good?', `${due.data.documents.length} file(s) are past their keep-until date and not on hold.`, [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete', primary: true }])) !== 'ok') return;
            (await act(api('POST', '/v1/documents/purge', { ids: due.data.documents.map((d: any) => d.id) }), 'Deleted.')) && due.reload();
          }}
        >
          Delete them
        </button>
      )}
      {edit && (
        <FormDialog
          title="Retention rule"
          onClose={() => setEdit(null)}
          initial={edit}
          fields={[
            { name: 'category', label: 'Kind', type: 'select', required: true, options: ['offer', 'tax_form', 'i9', 'policy', 'receipt', 'review', 'medical', 'contract', 'certification', 'other'].map((c) => ({ value: c, label: human(c) })) },
            { name: 'yearsAfterCreated', label: 'Keep for years after the document', type: 'number' },
            { name: 'yearsAfterTermination', label: 'And years after the person leaves', type: 'number' },
            { name: 'note', label: 'Note', advanced: true }
          ]}
          onSubmit={async (v) => (await act(api('POST', '/v1/retention-rules', v), 'Saved.')) && (setEdit(null), reload())}
        />
      )}
    </>
  );
}
