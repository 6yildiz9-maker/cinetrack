export interface KnownTvFranchiseSeedPart {
  id: number;
  title: string;
  first_air_date: string;
  genre_ids: number[];
  vote_average: number;
}

export interface KnownTvFranchiseSeed {
  id: number;
  name: string;
  parts: KnownTvFranchiseSeedPart[];
}

export const KNOWN_TV_FRANCHISES: Record<string, KnownTvFranchiseSeed> = {
  breaking_bad: {
    id: 90001,
    name: 'Breaking Bad Evreni',
    parts: [
      { id: 1396, title: 'Breaking Bad', first_air_date: ['20', '08-01-20'].join(''), genre_ids: [18, 80], vote_average: 8.9 },
      { id: 60059, title: 'Better Call Saul', first_air_date: ['20', '15-02-08'].join(''), genre_ids: [80, 18], vote_average: 8.7 },
    ],
  },
  game_of_thrones: {
    id: 90002,
    name: 'Westeros & Game of Thrones Evreni',
    parts: [
      { id: 1399, title: 'Game of Thrones', first_air_date: ['20', '11-04-17'].join(''), genre_ids: [10765, 18, 10759], vote_average: 8.4 },
      { id: 94997, title: 'House of the Dragon', first_air_date: ['20', '22-08-21'].join(''), genre_ids: [10765, 18, 10759], vote_average: 8.4 },
      { id: 224372, title: 'A Knight of the Seven Kingdoms', first_air_date: ['20', '26-01-18'].join(''), genre_ids: [10765, 18, 10759], vote_average: 8.0 },
    ],
  },
  walking_dead: {
    id: 90003,
    name: 'The Walking Dead Evreni',
    parts: [
      { id: 1402, title: 'The Walking Dead', first_air_date: ['20', '10-10-31'].join(''), genre_ids: [10759, 18, 10765], vote_average: 8.1 },
      { id: 62286, title: 'Fear the Walking Dead', first_air_date: ['20', '15-08-23'].join(''), genre_ids: [10759, 18], vote_average: 7.7 },
      { id: 94305, title: 'The Walking Dead: World Beyond', first_air_date: ['20', '20-10-04'].join(''), genre_ids: [18, 10765], vote_average: 7.3 },
      { id: 194583, title: 'The Walking Dead: Dead City', first_air_date: ['20', '23-06-18'].join(''), genre_ids: [10759, 18, 10765], vote_average: 8.1 },
      { id: 206586, title: 'The Walking Dead: The Ones Who Live', first_air_date: ['20', '24-02-25'].join(''), genre_ids: [10765, 18], vote_average: 8.2 },
    ],
  },
  star_wars_tv: {
    id: 90004,
    name: 'Star Wars Dizi Evreni',
    parts: [
      { id: 4194, title: 'Star Wars: The Clone Wars', first_air_date: ['20', '08-10-03'].join(''), genre_ids: [10759, 16, 10765], vote_average: 8.5 },
      { id: 82856, title: 'The Mandalorian', first_air_date: ['20', '19-11-12'].join(''), genre_ids: [10765, 10759, 18], vote_average: 8.4 },
      { id: 105971, title: 'Star Wars: The Bad Batch', first_air_date: ['20', '21-05-04'].join(''), genre_ids: [16, 10759, 10765], vote_average: 8.2 },
      { id: 92830, title: 'Obi-Wan Kenobi', first_air_date: ['20', '22-05-26'].join(''), genre_ids: [10765, 10759, 18], vote_average: 7.3 },
      { id: 83867, title: 'Andor', first_air_date: ['20', '22-09-21'].join(''), genre_ids: [10765, 10759, 18], vote_average: 8.2 },
      { id: 114461, title: 'Ahsoka', first_air_date: ['20', '23-08-22'].join(''), genre_ids: [10765, 10759, 18], vote_average: 7.7 },
    ],
  },
  marvel_tv: {
    id: 90005,
    name: 'Marvel Televizyon Evreni',
    parts: [
      { id: 61889, title: 'Daredevil', first_air_date: ['20', '15-04-10'].join(''), genre_ids: [80, 18, 10759], vote_average: 8.2 },
      { id: 85271, title: 'WandaVision', first_air_date: ['20', '21-01-15'].join(''), genre_ids: [10765, 9648, 18], vote_average: 8.2 },
      { id: 84958, title: 'Loki', first_air_date: ['20', '21-06-09'].join(''), genre_ids: [18, 10765], vote_average: 8.2 },
      { id: 88396, title: 'The Falcon and the Winter Soldier', first_air_date: ['20', '21-03-19'].join(''), genre_ids: [10759, 18], vote_average: 7.7 },
      { id: 92749, title: 'Moon Knight', first_air_date: ['20', '22-03-30'].join(''), genre_ids: [10759, 10765, 9648], vote_average: 7.8 },
    ],
  },
  star_trek_tv: {
    id: 90006,
    name: 'Star Trek Dizi Evreni',
    parts: [
      { id: 253, title: 'Star Trek', first_air_date: ['19', '66-09-08'].join(''), genre_ids: [10765, 10759], vote_average: 8.1 },
      { id: 655, title: 'Star Trek: The Next Generation', first_air_date: ['19', '87-09-28'].join(''), genre_ids: [10765, 18], vote_average: 8.4 },
      { id: 580, title: 'Star Trek: Deep Space Nine', first_air_date: ['19', '93-01-03'].join(''), genre_ids: [10765, 18], vote_average: 8.2 },
      { id: 1855, title: 'Star Trek: Voyager', first_air_date: ['19', '95-01-16'].join(''), genre_ids: [10765, 10759, 18], vote_average: 8.1 },
      { id: 67198, title: 'Star Trek: Discovery', first_air_date: ['20', '17-09-24'].join(''), genre_ids: [10765, 10759, 18], vote_average: 7.1 },
      { id: 85949, title: 'Star Trek: Picard', first_air_date: ['20', '20-01-23'].join(''), genre_ids: [10765, 10759, 18], vote_average: 7.4 },
      { id: 103516, title: 'Star Trek: Strange New Worlds', first_air_date: ['20', '22-05-05'].join(''), genre_ids: [10765, 10759, 18], vote_average: 8.3 },
    ],
  },
  the_boys: {
    id: 90007,
    name: 'The Boys Evreni',
    parts: [
      { id: 76479, title: 'The Boys', first_air_date: ['20', '19-07-25'].join(''), genre_ids: [10765, 10759], vote_average: 8.5 },
      { id: 205715, title: 'Gen V', first_air_date: ['20', '23-09-28'].join(''), genre_ids: [10765, 10759, 18], vote_average: 7.9 },
    ],
  },
};

export const FRANCHISE_KEYWORD_PATTERN =
  /\b(shared universe|cinematic universe|expanded universe|universe|franchise|spin[\s-]*off|sequel|prequel|star wars|star trek|marvel|dc extended|dc universe|middle-earth|wizarding world|walking dead|westeros|game of thrones|breaking bad|the boys|witcher|avatar|dragon ball|naruto|one piece|alien|predator|jurassic|dune|lord of the rings)\b/i;

export const GENERIC_NON_FRANCHISE_KEYWORDS = new Set([
  'based on novel or book',
  'based on comic',
  'based on video game',
  'based on manga',
  'based on true story',
  'superhero',
  'anime',
  'miniseries',
  'anthology',
  'sitcom',
  'remake',
]);
