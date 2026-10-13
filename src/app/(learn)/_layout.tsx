import { Stack, usePathname } from 'expo-router';
import { View } from 'react-native';

import { LeaveGuardProvider } from '@/components/leave-guard';
import { LearnerHeader, quizReports } from '@/components/learner-header';

// The learner area: one shared header above the screens' stack.
export default function LearnLayout() {
  const quizzes = quizReports.useReports();
  // The shown quiz's report: a stack may keep other quiz screens mounted
  // behind the current one, the last mounted is on top.
  const [section, id] = usePathname().split('/').filter(Boolean);
  const shown =
    section === 'quizzes' ? quizzes.values.findLast((report) => report.quizId === id) : undefined;
  const progress = shown?.progress ?? 'idle';

  return (
    <LeaveGuardProvider risk={progress === 'answered' ? 'quiz' : null}>
      <quizReports.Provider value={quizzes.reports}>
        <View className="flex-1 bg-gray-50">
          <LearnerHeader progress={progress} />
          <Stack screenOptions={{ headerShown: false }} />
        </View>
      </quizReports.Provider>
    </LeaveGuardProvider>
  );
}
