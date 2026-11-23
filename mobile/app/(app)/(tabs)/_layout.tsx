import { Tabs } from 'expo-router';
import { BookOpen, FileText, SlidersHorizontal, SquareCheck } from 'lucide-react-native';
import { useWorkspace } from '../../../src/session';
import { fonts, useTheme } from '../../../src/theme';

export default function TabsLayout() {
  const theme = useTheme();
  const workspace = useWorkspace();
  const today = workspace.todayTasks().length;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accentText,
        tabBarInactiveTintColor: theme.c.secondary,
        tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 12 },
        tabBarStyle: {
          backgroundColor: theme.c.tabBar,
          borderTopColor: theme.c.line,
        },
        sceneStyle: { backgroundColor: theme.c.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Заметки', tabBarIcon: ({ color }) => <FileText color={color} size={24} /> }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Задачи',
          tabBarIcon: ({ color }) => <SquareCheck color={color} size={24} />,
          tabBarBadge: today ? today : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.accent, fontFamily: fonts.semibold, fontSize: 11 },
        }}
      />
      <Tabs.Screen
        name="notebooks"
        options={{ title: 'Книжки', tabBarIcon: ({ color }) => <BookOpen color={color} size={24} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Настройки',
          tabBarIcon: ({ color }) => <SlidersHorizontal color={color} size={24} />,
        }}
      />
    </Tabs>
  );
}
