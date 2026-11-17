import {
  Book,
  BookOpen,
  NotebookPen,
  Folder,
  Briefcase,
  House,
  Heart,
  Star,
  Lightbulb,
  GraduationCap,
  Music,
  Headphones,
  Mic,
  Radio,
  Camera,
  Film,
  Palette,
  Code,
  Plane,
  Globe,
  Coffee,
  Utensils,
  Dumbbell,
  Leaf,
} from 'lucide-react';

export const notebookIcons = [
  { id: 'book', label: 'Книга', icon: Book },
  { id: 'book-open', label: 'Чтение', icon: BookOpen },
  { id: 'notebook', label: 'Дневник', icon: NotebookPen },
  { id: 'folder', label: 'Папка', icon: Folder },
  { id: 'briefcase', label: 'Работа', icon: Briefcase },
  { id: 'house', label: 'Дом', icon: House },
  { id: 'heart', label: 'Личное', icon: Heart },
  { id: 'star', label: 'Избранное', icon: Star },
  { id: 'lightbulb', label: 'Идеи', icon: Lightbulb },
  { id: 'graduation-cap', label: 'Учёба', icon: GraduationCap },
  { id: 'music', label: 'Музыка', icon: Music },
  { id: 'headphones', label: 'Аудио', icon: Headphones },
  { id: 'mic', label: 'Микрофон', icon: Mic },
  { id: 'radio', label: 'Радио', icon: Radio },
  { id: 'camera', label: 'Фотография', icon: Camera },
  { id: 'film', label: 'Кино', icon: Film },
  { id: 'palette', label: 'Творчество', icon: Palette },
  { id: 'code', label: 'Программирование', icon: Code },
  { id: 'plane', label: 'Путешествия', icon: Plane },
  { id: 'globe', label: 'Мир', icon: Globe },
  { id: 'coffee', label: 'Кофе', icon: Coffee },
  { id: 'utensils', label: 'Рецепты', icon: Utensils },
  { id: 'dumbbell', label: 'Спорт', icon: Dumbbell },
  { id: 'leaf', label: 'Природа', icon: Leaf },
];

export function NotebookIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const Icon = notebookIcons.find((item) => item.id === name)?.icon ?? Book;
  return <Icon size={size} aria-hidden="true" />;
}

export function NotebookIconPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="notebook-icon-picker">
      <legend>Иконка книжки</legend>
      <div className="notebook-icon-grid">
        {notebookIcons.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
