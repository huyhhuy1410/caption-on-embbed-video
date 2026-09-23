import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptService, Word } from './transcript.service';
// Helper tạo một từ với videoStart cho trước
function makeWord(videoStart: number): Word {
  return {
    w: 'test',
    s: 0,
    e: 0.5,
    videoStart,
    videoEnd: videoStart + 0.5,
    captionStart: videoStart,
    c: 1,
  };
}
describe('TranscriptService', () => {
  let service: TranscriptService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TranscriptService],
    }).compile();
    service = module.get<TranscriptService>(TranscriptService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
  it('keeps captionStart when replaying cached words', () => {
    const word = makeWord(4.2);
    word.captionStart = 4.0;

    service.addWords([word]);

    expect(service.getRange(4, 5)).toEqual([
      expect.objectContaining({ captionStart: 4.0 }),
    ]);
  });

  describe('translations', () => {
    it('returns a stored translation for its captionStart', () => {
      service.setTranslation({
        captionStart: 12.0,
        text: 'the model overfits',
        vi: 'mô hình bị quá khớp',
      });

      expect(service.getTranslation(12.0)?.vi).toBe('mô hình bị quá khớp');
      expect(service.getTranslations(11, 13)).toEqual([
        {
          captionStart: 12.0,
          text: 'the model overfits',
          vi: 'mô hình bị quá khớp',
        },
      ]);
    });

    it('getTranslation lets the gateway skip work already done', () => {
      expect(service.getTranslation(4.0)).toBeUndefined();
      service.setTranslation({ captionStart: 4.0, text: 'a', vi: 'b' });
      expect(service.getTranslation(4.0)).toEqual({
        captionStart: 4.0,
        text: 'a',
        vi: 'b',
      });
    });

    it('filters by range and sorts by captionStart', () => {
      service.setTranslation({ captionStart: 30, text: 'c', vi: 'C' });
      service.setTranslation({ captionStart: 10, text: 'a', vi: 'A' });
      service.setTranslation({ captionStart: 20, text: 'b', vi: 'B' });

      // 20 nằm ngoài [21, 31] ⇒ chỉ còn 30
      expect(service.getTranslations(21, 31)).toEqual([
        { captionStart: 30, text: 'c', vi: 'C' },
      ]);
      // cả ba, đã sort
      expect(service.getTranslations(0, 100).map((t) => t.captionStart)).toEqual(
        [10, 20, 30],
      );
    });

    it('drops a translation past TTL on read', () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      service.setTranslation({ captionStart: 5, text: 'a', vi: 'A' });

      nowSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
      expect(service.getTranslations(0, 10)).toEqual([]);
      nowSpy.mockRestore();
    });

    it('evicts the least-recently-used translation when over MAX_BUCKETS', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      for (let i = 0; i < 301; i++) {
        fakeNow = i;
        service.setTranslation({
          captionStart: i,
          text: `t${i}`,
          vi: `v${i}`,
        });
      }

      expect(service.getTranslation(0)).toBeUndefined();
      expect(service.getTranslation(300)).toBeDefined();
      nowSpy.mockRestore();
    });
  });

  describe('TTL', () => {
    it('removes a bucket that has not been accessed past TTL', () => {
      // BƯỚC 1: mock Date.now về một mốc cố định
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      // addWords với videoStart = 0 (key 0)
      service.addWords([makeWord(0)]);

      // BƯỚC 2: giả vờ thời gian trôi hơn 30 phút
      nowSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
      // gọi getRange -> bucket key 0 bị xoá -> kết quả rỗng
      const result = service.getRange(0, 0.5);
      // expect(...).toEqual([]);
      expect(result).toEqual([]);
      nowSpy.mockRestore();
    });
  });

  describe('LRU', () => {
    it('evicts the least-recently-used bucket when over MAX_BUCKETS', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      for (let i = 0; i < 301; i++) {
        fakeNow = i;
        service.addWords([makeWord(i)]);
      }
      expect(service.getRange(0, 0.5)).toEqual([]);
      expect(service.getRange(1, 1.5)).toHaveLength(1);
      nowSpy.mockRestore();
    });

    it('keeps a recently-touched bucket during eviction', () => {
      let fakeNow = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      service.addWords([makeWord(0)]); // key 0, lastAccess = 0
      fakeNow = 1;
      for (let i = 1; i <= 299; i++) {
        // thêm 299 bucket (key 1..299)
        fakeNow = i;
        service.addWords([makeWord(i)]);
      }
      // giờ có 300 bucket, chưa vượt trần (300 = MAX), chưa evict.

      fakeNow = 1_000_000; // nhảy thật xa
      service.getRange(0, 0.5); // touch key 0 -> lastAccess = 1_000_000 (MỚI NHẤT)
      fakeNow = 1_000_001;
      service.addWords([makeWord(300)]); // thêm bucket thứ 301 -> vượt trần -> evict
      // lúc này lastAccess: key 0 = 1_000_000, các key 1..299 = 1..299, key 300 = ?
      // key 300 sẽ lấy Date.now() hiện tại = 1_000_000 (fakeNow chưa đổi)
      // -> hai bucket cùng lastAccess 1_000_000, còn lại nhỏ hơn -> đuổi key 1 (nhỏ nhất)

      expect(service.getRange(0, 0.5)).toHaveLength(1); // key 0 vẫn sống
      nowSpy.mockRestore();
    });
  });
});
