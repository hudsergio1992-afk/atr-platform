import { TrackingMode } from "@/lib/types";

/**
 * Типовая работа справочника: наименование, ходовая единица измерения
 * и способ, которым прораб отмечает её выполнение.
 */
export interface StageTemplateItem {
  name: string;
  unit?: string;
  tracking: TrackingMode;
}

export interface StageTemplateGroup {
  key: string;
  name: string;
  items: StageTemplateItem[];
}

/**
 * Справочник этапов агропромышленного строительства: элеваторы, зерносушильные
 * комплексы, силосные корпуса, семенные заводы.
 *
 * Работы, которые физически измеряются (бетон, металл, сваи), идут «по объёму».
 * Штучные, но длительные — сборка силоса, монтаж нории, пусконаладка — «по проценту»:
 * силос всего один, а собирается месяц, и отмечать его долю в штуках бессмысленно.
 */
export const STAGE_TEMPLATES: StageTemplateGroup[] = [
  {
    key: "prep",
    name: "Подготовительный период",
    items: [
      { name: "Геодезическая разбивка осей", tracking: "percent" },
      { name: "Вынос инженерных сетей из пятна застройки", tracking: "percent" },
      { name: "Устройство временного ограждения", unit: "п.м", tracking: "volume" },
      { name: "Временные здания и сооружения (бытовой городок)", unit: "шт", tracking: "volume" },
      { name: "Временные дороги и площадки складирования", unit: "м²", tracking: "volume" },
      { name: "Временное электроснабжение и водоснабжение", tracking: "percent" },
      { name: "Снятие и складирование плодородного слоя", unit: "м³", tracking: "volume" },
    ],
  },
  {
    key: "earth",
    name: "Земляные работы",
    items: [
      { name: "Разработка котлована", unit: "м³", tracking: "volume" },
      { name: "Водопонижение", tracking: "percent" },
      { name: "Уплотнение основания", unit: "м²", tracking: "volume" },
      { name: "Устройство щебёночной подготовки", unit: "м³", tracking: "volume" },
      { name: "Обратная засыпка с послойным уплотнением", unit: "м³", tracking: "volume" },
      { name: "Вертикальная планировка площадки", unit: "м²", tracking: "volume" },
    ],
  },
  {
    key: "piles",
    name: "Свайные работы",
    items: [
      { name: "Погружение забивных свай", unit: "шт", tracking: "volume" },
      { name: "Устройство буронабивных свай", unit: "шт", tracking: "volume" },
      { name: "Срубка оголовков свай", unit: "шт", tracking: "volume" },
      { name: "Статические испытания свай", unit: "шт", tracking: "volume" },
      { name: "Динамические испытания свай", unit: "шт", tracking: "volume" },
    ],
  },
  {
    key: "foundation",
    name: "Фундаменты",
    items: [
      { name: "Бетонная подготовка", unit: "м³", tracking: "volume" },
      { name: "Гидроизоляция фундаментов", unit: "м²", tracking: "volume" },
      { name: "Армирование ростверка", unit: "т", tracking: "volume" },
      { name: "Опалубочные работы", unit: "м²", tracking: "volume" },
      { name: "Бетонирование ростверка", unit: "м³", tracking: "volume" },
      { name: "Бетонирование фундаментной плиты", unit: "м³", tracking: "volume" },
      { name: "Фундаменты под нории и транспортёры", unit: "м³", tracking: "volume" },
      { name: "Фундамент под зерносушилку", unit: "м³", tracking: "volume" },
      { name: "Установка анкерных групп и закладных деталей", unit: "компл.", tracking: "volume" },
      { name: "Устройство приямков и каналов", unit: "м³", tracking: "volume" },
    ],
  },
  {
    key: "silo",
    name: "Силосный корпус",
    items: [
      { name: "Приёмка и входной контроль металлоконструкций силоса", tracking: "percent" },
      { name: "Монтаж опорных стоек силоса", unit: "шт", tracking: "volume" },
      { name: "Сборка силоса (крыша, кольца корпуса)", unit: "шт", tracking: "percent" },
      { name: "Монтаж конусного днища силоса", unit: "шт", tracking: "percent" },
      { name: "Монтаж зачистных шнеков и разгрузочных устройств", unit: "шт", tracking: "percent" },
      { name: "Монтаж систем вентиляции силосов", unit: "шт", tracking: "percent" },
      { name: "Монтаж термометрии силосов", unit: "шт", tracking: "percent" },
      { name: "Монтаж лестниц, площадок обслуживания и ограждений", unit: "т", tracking: "volume" },
      { name: "Монтаж взрыворазрядителей", unit: "шт", tracking: "volume" },
      { name: "Герметизация и антикоррозионная защита", unit: "м²", tracking: "volume" },
    ],
  },
  {
    key: "transport",
    name: "Транспортное оборудование",
    items: [
      { name: "Монтаж завальной ямы (приёмного бункера)", unit: "шт", tracking: "percent" },
      { name: "Монтаж автомобилеразгрузчика", unit: "шт", tracking: "percent" },
      { name: "Монтаж норий", unit: "шт", tracking: "percent" },
      { name: "Монтаж опор и галерей", unit: "т", tracking: "volume" },
      { name: "Монтаж верхних цепных конвейеров", unit: "п.м", tracking: "volume" },
      { name: "Монтаж нижних цепных конвейеров", unit: "п.м", tracking: "volume" },
      { name: "Монтаж ленточных конвейеров", unit: "п.м", tracking: "volume" },
      { name: "Монтаж самотёков, задвижек и перекидных клапанов", unit: "компл.", tracking: "volume" },
      { name: "Монтаж надвесовых и подвесовых бункеров", unit: "шт", tracking: "percent" },
    ],
  },
  {
    key: "drying",
    name: "Зерносушильный комплекс",
    items: [
      { name: "Сборка корпуса сушилки", unit: "шт", tracking: "percent" },
      { name: "Монтаж топочного блока и горелки", unit: "шт", tracking: "percent" },
      { name: "Монтаж вентиляторов и циклонов", unit: "шт", tracking: "volume" },
      { name: "Обвязка газопроводом", unit: "п.м", tracking: "volume" },
      { name: "Монтаж системы управления сушилкой", tracking: "percent" },
      { name: "Монтаж оперативных бункеров сушилки", unit: "шт", tracking: "percent" },
    ],
  },
  {
    key: "cleaning",
    name: "Зерноочистка и аспирация",
    items: [
      { name: "Монтаж сепараторов предварительной очистки", unit: "шт", tracking: "percent" },
      { name: "Монтаж сепараторов первичной очистки", unit: "шт", tracking: "percent" },
      { name: "Монтаж аспирационных сетей", unit: "п.м", tracking: "volume" },
      { name: "Монтаж циклонов и фильтров", unit: "шт", tracking: "volume" },
      { name: "Монтаж воздуховодов", unit: "п.м", tracking: "volume" },
    ],
  },
  {
    key: "seed",
    name: "Семенной завод",
    items: [
      { name: "Монтаж триерных блоков", unit: "шт", tracking: "percent" },
      { name: "Монтаж калибровочной машины", unit: "шт", tracking: "percent" },
      { name: "Монтаж пневмостола", unit: "шт", tracking: "percent" },
      { name: "Монтаж фотосепаратора", unit: "шт", tracking: "percent" },
      { name: "Монтаж протравливателя", unit: "шт", tracking: "percent" },
      { name: "Монтаж фасовочной линии", unit: "шт", tracking: "percent" },
      { name: "Монтаж линии затаривания в биг-бэги", unit: "шт", tracking: "percent" },
    ],
  },
  {
    key: "building",
    name: "Здания и сооружения",
    items: [
      { name: "Монтаж металлокаркаса", unit: "т", tracking: "volume" },
      { name: "Монтаж стеновых сэндвич-панелей", unit: "м²", tracking: "volume" },
      { name: "Монтаж кровельного покрытия", unit: "м²", tracking: "volume" },
      { name: "Устройство бетонных полов с упрочнением", unit: "м²", tracking: "volume" },
      { name: "Монтаж ворот, дверей и окон", unit: "шт", tracking: "volume" },
      { name: "Устройство отмостки", unit: "п.м", tracking: "volume" },
      { name: "Отделочные работы", unit: "м²", tracking: "volume" },
    ],
  },
  {
    key: "utilities",
    name: "Инженерные сети",
    items: [
      { name: "Наружные сети электроснабжения", unit: "п.м", tracking: "volume" },
      { name: "Монтаж трансформаторной подстанции", unit: "шт", tracking: "percent" },
      { name: "Монтаж силового оборудования и шкафов", unit: "шт", tracking: "volume" },
      { name: "Прокладка кабельных трасс", unit: "п.м", tracking: "volume" },
      { name: "Внутреннее электроснабжение и освещение", tracking: "percent" },
      { name: "Наружные сети водоснабжения", unit: "п.м", tracking: "volume" },
      { name: "Наружные сети канализации", unit: "п.м", tracking: "volume" },
      { name: "Наружные сети газоснабжения", unit: "п.м", tracking: "volume" },
      { name: "Отопление и вентиляция зданий", tracking: "percent" },
    ],
  },
  {
    key: "automation",
    name: "Автоматизация и АСУ ТП",
    items: [
      { name: "Монтаж шкафов управления", unit: "шт", tracking: "volume" },
      { name: "Прокладка контрольных кабелей", unit: "п.м", tracking: "volume" },
      { name: "Монтаж датчиков уровня и температуры", unit: "шт", tracking: "volume" },
      { name: "Монтаж АРМ оператора", unit: "шт", tracking: "percent" },
      { name: "Программирование и настройка АСУ ТП", tracking: "percent" },
    ],
  },
  {
    key: "safety",
    name: "Взрывозащита, пожарная безопасность, молниезащита",
    items: [
      { name: "Устройство заземляющего контура", unit: "п.м", tracking: "volume" },
      { name: "Молниезащита", tracking: "percent" },
      { name: "Монтаж пожарной сигнализации", tracking: "percent" },
      { name: "Монтаж систем пожаротушения", tracking: "percent" },
      { name: "Монтаж систем контроля подшипников и подпора", unit: "шт", tracking: "volume" },
    ],
  },
  {
    key: "landscaping",
    name: "Благоустройство",
    items: [
      { name: "Устройство автомобильных весов", unit: "шт", tracking: "percent" },
      { name: "Асфальтобетонное покрытие проездов", unit: "м²", tracking: "volume" },
      { name: "Устройство ограждения территории", unit: "п.м", tracking: "volume" },
      { name: "Наружное освещение территории", unit: "шт", tracking: "volume" },
      { name: "Озеленение", unit: "м²", tracking: "volume" },
    ],
  },
  {
    key: "commissioning",
    name: "Пусконаладка и сдача",
    items: [
      { name: "Индивидуальные испытания оборудования", tracking: "percent" },
      { name: "Комплексное опробование вхолостую", tracking: "percent" },
      { name: "Комплексное опробование под нагрузкой", tracking: "percent" },
      { name: "Испытания на зерне", tracking: "percent" },
      { name: "Обучение персонала заказчика", tracking: "percent" },
      { name: "Оформление исполнительной документации", tracking: "percent" },
      { name: "Сдача объекта заказчику", tracking: "percent" },
    ],
  },
  {
    key: "design",
    name: "Проектирование",
    items: [
      { name: "Инженерно-геодезические изыскания", tracking: "percent" },
      { name: "Инженерно-геологические изыскания", tracking: "percent" },
      { name: "Разработка проектной документации", tracking: "percent" },
      { name: "Прохождение экспертизы", tracking: "percent" },
      { name: "Разработка рабочей документации", tracking: "percent" },
      { name: "Авторский надзор", tracking: "percent" },
    ],
  },
];

/** Сколько всего типовых работ в справочнике — показывается на кнопке. */
export const STAGE_TEMPLATES_COUNT = STAGE_TEMPLATES.reduce((s, g) => s + g.items.length, 0);
