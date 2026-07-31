// ============================================================
// <Icon /> — единственный способ нарисовать интерфейсную иконку.
//
// Правило системы (DESIGN.md): интерфейсные иконки — Phosphor, начертание
// Light (тонкий штрих ~1.5px). Прямой импорт из '@phosphor-icons/react' в
// страницах ЗАПРЕЩЁН — иначе набор расползётся, а сменить поставщика иконок
// станет невозможно. Не хватает иконки — добавь строку в ICONS ниже.
//
// Эмодзи, которые пользователь выбрал САМ и которые лежат в БД (иконка
// Группы, своей валюты, категории финансов, лота, хотелки), иконками НЕ
// заменяются — они остаются эмодзи и подаются через <EmojiIcon/>.
//
// Импорт из подпути '/ssr': эти версии не читают React-контекст, поэтому
// работают и в серверных, и в клиентских компонентах без 'use client'.
// ============================================================
import {
  Archive,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  ArrowsMerge,
  ArrowsSplit,
  At,
  Bell,
  BellRinging,
  Brain,
  BracketsCurly,
  Briefcase,
  Broadcast,
  Buildings,
  CalendarBlank,
  CalendarCheck,
  CalendarPlus,
  Camera,
  CameraSlash,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChartLine,
  ChatCenteredText,
  ChatCircle,
  ChatsCircle,
  Check,
  CheckCircle,
  CirclesThreePlus,
  Clock,
  ClockCountdown,
  CloudArrowUp,
  Coins,
  Copy,
  CreditCard,
  Crown,
  CursorClick,
  Database,
  DeviceMobile,
  DotsSixVertical,
  DotsThree,
  DownloadSimple,
  Envelope,
  Eye,
  EyeSlash,
  Faders,
  FileArrowDown,
  FilePlus,
  FileText,
  Flag,
  FlagCheckered,
  FloppyDisk,
  Folder,
  FolderOpen,
  Function as FunctionIcon,
  Funnel,
  Gear,
  Gift,
  GitBranch,
  Globe,
  GraduationCap,
  HandCoins,
  Handshake,
  HardDrives,
  Heart,
  Hourglass,
  House,
  Image as ImageIcon,
  Info,
  Key,
  Lightning,
  Link as LinkIcon,
  List,
  ListChecks,
  LockSimple,
  MagicWand,
  MagnifyingGlass,
  MapPin,
  Microphone,
  MicrophoneSlash,
  Minus,
  Monitor,
  Note,
  Paperclip,
  PauseCircle,
  Pencil,
  PencilSimple,
  Phone,
  PhoneSlash,
  PiggyBank,
  Play,
  Plugs,
  Plus,
  Prohibit,
  Question,
  Receipt,
  Record as RecordIcon,
  Repeat,
  Robot,
  Scales,
  ShareNetwork,
  ShieldCheck,
  ShoppingCart,
  SignIn,
  SignOut,
  Smiley,
  Sparkle,
  SpeakerHigh,
  SpeakerSlash,
  SquaresFour,
  Stop,
  Storefront,
  Sun,
  Table,
  Target,
  TelegramLogo,
  Tray,
  TreeStructure,
  TrendDown,
  TrendUp,
  Trash,
  UploadSimple,
  User,
  UserCircle,
  UserPlus,
  Users,
  UsersFour,
  UsersThree,
  VideoCamera,
  VideoCameraSlash,
  Wallet,
  Warning,
  WarningCircle,
  WhatsappLogo,
  X,
} from '@phosphor-icons/react/ssr';
import { memo, type CSSProperties } from 'react';

/**
 * Реестр иконок: семантический ключ → компонент Phosphor.
 * Ключ описывает СМЫСЛ, а не рисунок («delete», а не «trash»), чтобы можно
 * было поменять рисунок в одном месте, не трогая 47 страниц.
 */
export const ICONS = {
  // --- навигация и сервисы ---
  home: House,
  dashboard: SquaresFour,
  tasks: ListChecks,
  calendar: CalendarBlank,
  messenger: ChatCircle,
  chats: ChatsCircle,
  circle: Users,
  people: UsersThree,
  shop: Storefront,
  finance: Wallet,
  recorder: Microphone,
  mentions: At,
  workspace: Buildings,
  staff: Briefcase,
  processes: TreeStructure,
  office: Monitor,
  journal: Note,
  docs: FileText,
  settings: Gear,
  support: Question,
  profile: UserCircle,
  apps: CirclesThreePlus,

  // --- действия ---
  add: Plus,
  remove: Minus,
  close: X,
  edit: PencilSimple,
  draw: Pencil,
  delete: Trash,
  save: FloppyDisk,
  search: MagnifyingGlass,
  filter: Funnel,
  more: DotsThree,
  drag: DotsSixVertical,
  copy: Copy,
  share: ShareNetwork,
  link: LinkIcon,
  download: DownloadSimple,
  upload: UploadSimple,
  uploadCloud: CloudArrowUp,
  attach: Paperclip,
  refresh: ArrowsClockwise,
  replay: ArrowClockwise,
  undo: ArrowCounterClockwise,
  external: ArrowSquareOut,
  archive: Archive,
  send: ArrowRight,

  // --- стрелки и каретки ---
  caretDown: CaretDown,
  caretUp: CaretUp,
  caretLeft: CaretLeft,
  caretRight: CaretRight,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,

  // --- статусы ---
  check: Check,
  checkCircle: CheckCircle,
  warning: Warning,
  warningCircle: WarningCircle,
  info: Info,
  blocked: Prohibit,
  pending: PauseCircle,
  inProgress: ArrowsClockwise,
  overdue: ClockCountdown,
  clock: Clock,
  flag: Flag,
  target: Target,

  // --- люди ---
  user: User,
  userAdd: UserPlus,
  crown: Crown,
  graduation: GraduationCap,
  handshake: Handshake,

  // --- оргструктура (сервис «Сотрудники») ---
  // Должность — тот же портфель, что у сервиса: ключи описывают смысл, а не рисунок.
  position: Briefcase,
  department: UsersFour,
  branch: MapPin,
  /** Место события/встречи — та же булавка, другой смысл. */
  location: MapPin,

  // --- деньги ---
  coins: Coins,
  card: CreditCard,
  receipt: Receipt,
  debt: HandCoins,
  savings: PiggyBank,
  gift: Gift,
  trendUp: TrendUp,
  trendDown: TrendDown,
  chart: ChartLine,

  // --- медиа и связь ---
  call: Phone,
  callEnd: PhoneSlash,
  video: VideoCamera,
  videoOff: VideoCameraSlash,
  mic: Microphone,
  micOff: MicrophoneSlash,
  camera: Camera,
  cameraOff: CameraSlash,
  speaker: SpeakerHigh,
  speakerOff: SpeakerSlash,
  play: Play,
  stop: Stop,
  record: RecordIcon,
  bell: Bell,
  bellRinging: BellRinging,
  mail: Envelope,

  // --- файлы ---
  file: FileText,
  filePlus: FilePlus,
  fileDownload: FileArrowDown,
  folder: Folder,
  folderOpen: FolderOpen,
  image: ImageIcon,
  table: Table,
  list: List,

  // --- ноды канваса «Процессы» ---
  // Ключи описывают роль ноды в схеме, а не рисунок: паспорт ноды на бэкенде
  // называет иконку именно этим ключом (эмодзи в паспортах отменены — DESIGN.md §3).
  click: CursorClick,
  broadcast: Broadcast,
  hourglass: Hourglass,
  condition: GitBranch,
  split: ArrowsSplit,
  merge: ArrowsMerge,
  loop: Repeat,
  variables: FunctionIcon,
  finish: FlagCheckered,
  robot: Robot,
  brain: Brain,
  memory: HardDrives,
  braces: BracketsCurly,
  sliders: Faders,
  telegram: TelegramLogo,
  whatsapp: WhatsappLogo,
  sms: ChatCenteredText,
  cart: ShoppingCart,

  // --- прочее ---
  eye: Eye,
  eyeOff: EyeSlash,
  lock: LockSimple,
  key: Key,
  signIn: SignIn,
  signOut: SignOut,
  shield: ShieldCheck,
  database: Database,
  plug: Plugs,
  globe: Globe,
  scales: Scales,
  device: DeviceMobile,
  ai: MagicWand,
  spark: Sparkle,
  smiley: Smiley, // кнопка выбора значка/эмодзи (композер чата)
  bolt: Lightning,
  heart: Heart,
  sun: Sun,
  empty: Tray,
  calendarAdd: CalendarPlus,
  calendarCheck: CalendarCheck,
} as const;

export type IconName = keyof typeof ICONS;

/** Начертания Phosphor. По умолчанию light — так требует дизайн-система. */
export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

export interface IconProps {
  name: IconName;
  /** Размер в px. Нав — 20, в карточках 16–22. */
  size?: number;
  /** По умолчанию наследует цвет текста. */
  color?: string;
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
  /** Иконка декоративная (по умолчанию) — скрыта от скринридеров.
   *  Если иконка единственный смысл кнопки, передай подпись. */
  label?: string;
}

// memo: иконка — самый массовый компонент приложения (строки списков, меню,
// карточки); пропсы примитивные, так что ре-рендер родителя не перестраивает SVG.
export const Icon = memo(function Icon({ name, size = 20, color, weight = 'light', className, style, label }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      color={color ?? 'currentColor'}
      weight={weight}
      className={className}
      style={{ flex: 'none', ...style }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
});

// EmojiIcon (значок в матовом круге) переехал в Glyph.tsx — туда же, где живёт
// разбор значения значка. Иначе получалось кольцо импортов: Glyph берёт отсюда
// Icon, а Icon брал бы оттуда разбор.
