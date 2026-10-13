import { type Href, router } from 'expo-router';
import { type GestureResponderEvent, Platform, Pressable, Text } from 'react-native';

import { useLeaveGuard } from '@/components/leave-guard';

// The header's and breadcrumb's controls: at least 44 × 44 px, reachable and
// usable by keyboard, and asking first when leaving would lose something
// (LeaveGuardProvider).

type Props = {
  label: string;
  /** A decorative sign before the label, such as ← or ✕; hidden from screen readers. */
  sign?: string;
  /** Keeps the label on one line, cut off with an ellipsis, so the control can shrink. */
  singleLine?: boolean;
};

/**
 * A link that leaves through the leave guard. On the web it is a real
 * anchor (open in a new tab works); a plain click is handled in the app,
 * like expo-router's Link does. react-native-web's Pressable replaces an
 * `onClick` prop with its own click handler, which calls `onPress` with the
 * click event (not for Alt+click), so the browser's own navigation is
 * stopped there.
 */
export function NavLink({ href, ...props }: Props & { href: string }) {
  const guard = useLeaveGuard();
  const go = () => guard(() => router.navigate(href as Href));
  const press =
    Platform.OS === 'web'
      ? {
          href,
          onPress: (event: GestureResponderEvent) => {
            const click = event as unknown as MouseEvent;
            if (click.metaKey || click.ctrlKey || click.shiftKey) return;
            if (click.button !== undefined && click.button !== 0) return;
            click.preventDefault();
            go();
          },
        }
      : { onPress: go };
  return (
    <Pressable role="link" {...press} className={`${TARGET} ${props.singleLine ? 'shrink' : ''}`}>
      <Label {...props} />
    </Pressable>
  );
}

/** A button that runs `onPress` through the leave guard. */
export function NavButton({ onPress, ...props }: Props & { onPress: () => void }) {
  const guard = useLeaveGuard();
  return (
    <Pressable role="button" onPress={() => guard(onPress)} className={TARGET}>
      <Label {...props} />
    </Pressable>
  );
}

const TARGET =
  'min-h-11 min-w-11 flex-row items-center justify-center rounded-lg px-2 hover:bg-gray-100 active:bg-gray-200';

function Label({ label, sign, singleLine }: Props) {
  return (
    <Text
      numberOfLines={singleLine ? 1 : undefined}
      className="shrink text-base font-semibold text-blue-700"
    >
      {sign ? <Text aria-hidden>{`${sign} `}</Text> : null}
      {label}
    </Text>
  );
}
