import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/confirm-dialog';

/** What leaving the shown screen would lose: a started quiz or a changed form. */
export type LeaveRisk = 'quiz' | 'form';

/** Runs `leave` at once, or after the visitor confirms losing what the screen holds. */
type Guard = (leave: () => void) => void;

// Without a provider (a screen rendered on its own) nothing is guarded.
const LeaveGuardContext = createContext<Guard>((leave) => leave());

/**
 * Asks before the header or breadcrumb leave a screen while `risk` says it
 * holds something. Browser and hardware back stay plain history back.
 */
export function LeaveGuardProvider({
  risk,
  children,
}: {
  risk: LeaveRisk | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<{ risk: LeaveRisk; leave: () => void } | null>(null);
  const guard = useCallback<Guard>(
    (leave) => {
      if (risk) setAsking({ risk, leave });
      else leave();
    },
    [risk],
  );
  const dialog = asking?.risk === 'quiz' ? 'nav.leaveDialog' : 'nav.discardDialog';

  return (
    <LeaveGuardContext.Provider value={guard}>
      {children}
      <ConfirmDialog
        visible={asking !== null}
        title={t(`${dialog}.title`)}
        message={t(`${dialog}.message`)}
        confirmLabel={t(`${dialog}.confirm`)}
        cancelLabel={t(`${dialog}.cancel`)}
        onConfirm={() => {
          setAsking(null);
          asking?.leave();
        }}
        onCancel={() => setAsking(null)}
      />
    </LeaveGuardContext.Provider>
  );
}

export const useLeaveGuard = () => useContext(LeaveGuardContext);
