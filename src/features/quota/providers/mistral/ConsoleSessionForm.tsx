/**
 * Console session cookie entry for the Mistral card.
 *
 * The included monthly budget lives behind the console's Ory session, so the dashboard
 * stores the cookie as the `mistral-console` provider key and api-call sends it as
 * `Cookie: $TOKEN$`. The value is written straight to the proxy config and is never
 * rendered back into the page.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { providersApi } from '@/services/api';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { buildMistralConsoleProviderConfig } from '../apiKey/compat';
import styles from './ConsoleSessionForm.module.scss';

export interface ConsoleSessionFormProps {
  /** True when a console entry already exists, so the action reads "update". */
  hasSession: boolean;
  onSaved?: () => void;
}

export function ConsoleSessionForm({ hasSession, onSaved }: ConsoleSessionFormProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cookie, setCookie] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const close = () => {
    setOpen(false);
    setCookie('');
    setError(null);
  };

  const save = async () => {
    const value = cookie.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      const providers = await providersApi.getOpenAIProviders();
      const { config, existing } = buildMistralConsoleProviderConfig(providers, value);
      if (existing) {
        await providersApi.updateOpenAIProvider(existing.name, existing.sourceIndex ?? 0, config);
      } else {
        await providersApi.createOpenAIProvider(config);
      }
      // The card needs the new auth-index, which only the provider list carries.
      await triggerHeaderRefresh();
      setSaved(true);
      setOpen(false);
      setCookie('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.root}>
      {open ? (
        <div className={styles.form}>
          <label className={styles.label} htmlFor="mistral-console-cookie">
            {t('mistral_quota.console_cookie_label')}
          </label>
          <input
            id="mistral-console-cookie"
            className={styles.input}
            type="password"
            value={cookie}
            onChange={(event) => {
              setCookie(event.target.value);
              setSaved(false);
            }}
            placeholder="ory_session_..."
            autoComplete="off"
            spellCheck={false}
          />
          <p className={styles.hint}>{t('mistral_quota.console_cookie_hint')}</p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.save}
              onClick={() => void save()}
              disabled={!cookie.trim() || saving}
            >
              {saving ? t('mistral_quota.console_cookie_saving') : t('common.save')}
            </button>
            <button type="button" className={styles.cancel} onClick={close}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.toggle} onClick={() => setOpen(true)}>
          {hasSession
            ? t('mistral_quota.console_cookie_update')
            : t('mistral_quota.console_cookie_connect')}
        </button>
      )}
      {saved && !open && <span className={styles.saved}>{t('mistral_quota.console_cookie_saved')}</span>}
    </div>
  );
}
