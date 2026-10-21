/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

export function createDataBackupControl({ context, serverClient, localize, notifyError, documentRef = globalThis.document }) {
    const root = documentRef.createElement('div');
    root.className = 'vertex-paygo-log-actions';
    root.hidden = true;
    const button = documentRef.createElement('button');
    button.id = 'vertex-paygo-data-backups';
    button.type = 'button';
    button.className = 'menu_button vertex-paygo-log-button';
    button.textContent = localize('vertex_paygo.backup.open');
    root.append(button);
    let destroyed = false;
    let busy = false;

    async function open() {
        if (destroyed || busy || root.hidden) return;
        busy = true; button.disabled = true;
        try {
            const report = await serverClient.listDataBackups();
            if (destroyed) return;
            const content = documentRef.createElement('div');
            content.className = 'vertex-paygo-data-recovery';
            const description = documentRef.createElement('p');
            description.textContent = localize('vertex_paygo.backup.description');
            const status = documentRef.createElement('p');
            const pending = report.pending?.status === 'queued' || report.pending?.status === 'failed';
            status.textContent = report.pending?.status === 'failed' ? localize('vertex_paygo.backup.failed', { code: report.pending.code })
                : pending ? localize('vertex_paygo.backup.queued')
                : report.errorCode ? localize('vertex_paygo.backup.failed', { code: report.errorCode })
                : report.pending?.status === 'restored' ? localize('vertex_paygo.backup.restored') : '';
            const select = documentRef.createElement('select');
            select.className = 'text_pole';
            select.setAttribute('aria-label', localize('vertex_paygo.backup.choose'));
            const more = documentRef.createElement('button');
            more.type = 'button'; more.className = 'menu_button';
            more.textContent = localize('vertex_paygo.backup.more');
            let cursor = report.nextCursor;
            function append(entries) {
                for (const entry of entries) {
                    const option = documentRef.createElement('option');
                    option.value = entry.id; option.disabled = !entry.restorable;
                    option.textContent = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : entry.id;
                    if (entry.reason) option.textContent += ' · ' + localize('vertex_paygo.backup.reason.' + entry.reason);
                    option.textContent += ' · ' + (entry.files ?? []).map(name => localize(name === 'usage-ledger.jsonl' ? 'vertex_paygo.backup.ledger' : 'vertex_paygo.backup.bridge')).join(', ');
                    if (!entry.restorable) option.textContent += ' — ' + localize('vertex_paygo.backup.damaged');
                    select.append(option);
                }
                const usable = [...select.options].find(option => !option.disabled);
                if (usable && !select.selectedOptions[0]?.disabled && select.value) return;
                select.value = usable?.value ?? '';
            }
            append(report.entries);
            more.hidden = !cursor || pending;
            more.addEventListener('click', async () => {
                more.disabled = true;
                try {
                    const next = await serverClient.listDataBackups(cursor);
                    if (destroyed) return;
                    append(next.entries); cursor = next.nextCursor; more.hidden = !cursor;
                } catch (error) { status.textContent = error.message; }
                finally { more.disabled = false; }
            });
            if (!report.entries.length) status.textContent ||= localize('vertex_paygo.backup.empty');
            select.hidden = pending || !report.entries.length;
            content.append(description, status, select, more);
            const canAct = pending || report.entries.some(entry => entry.restorable) || Boolean(cursor);
            const dialog = new context.Popup(content, canAct ? context.POPUP_TYPE.CONFIRM : context.POPUP_TYPE.TEXT, '', {
                okButton: localize(!canAct ? 'vertex_paygo.backup.close' : pending ? 'vertex_paygo.backup.cancel_restore' : 'vertex_paygo.backup.restore'),
                cancelButton: localize('vertex_paygo.backup.close'),
                defaultResult: context.POPUP_RESULT.NEGATIVE,
            });
            const result = await dialog.show();
            if (destroyed || !canAct || result !== context.POPUP_RESULT.AFFIRMATIVE) return;
            if (pending) {
                await serverClient.cancelDataRestore();
                if (!destroyed) await context.Popup.show.text(localize('vertex_paygo.backup.title'), localize('vertex_paygo.backup.cancelled'));
                return;
            }
            if (!select.value || select.selectedOptions[0]?.disabled) return;
            const confirmed = await context.Popup.show.confirm(localize('vertex_paygo.backup.title'), localize('vertex_paygo.backup.confirm'), {
                okButton: localize('vertex_paygo.backup.restore'), defaultResult: context.POPUP_RESULT.NEGATIVE,
            });
            if (destroyed || confirmed !== context.POPUP_RESULT.AFFIRMATIVE) return;
            await serverClient.scheduleDataRestore(select.value);
            if (!destroyed) await context.Popup.show.text(localize('vertex_paygo.backup.title'), localize('vertex_paygo.backup.queued'));
        } catch (error) { if (!destroyed) notifyError(error.message); }
        finally { busy = false; button.disabled = false; }
    }
    button.addEventListener('click', open);
    return {
        root, open,
        setAvailable(value) { root.hidden = !value; },
        destroy() { destroyed = true; button.removeEventListener('click', open); root.remove(); },
    };
}
