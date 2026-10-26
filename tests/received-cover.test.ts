import assert from 'node:assert/strict';
import test from 'node:test';
import { bookCoverSource } from '../miniprogram/services/bookCoverSource';
import { prepareImport } from '../miniprogram/services/chapterPackageService';
import { exportChapterPackage } from '../miniprogram/services/chapterPackageService';

test('received cover uses receiver photo mapping and explicit recipient choice takes priority', () => {
  const exported = exportChapterPackage({chapter:{id:'chapter-test',title:'纸船',memoryIds:[],content:[{text:'纸船\n'}]},
    packageId:'cp_cover123456',displayName:'我',createdAt:'2026-10-26T10:00:00.000Z',coverPhotoId:'photo-cover',
    images:{'photo-cover':{mime:'image/jpeg',bytes:4,sha256:'a'.repeat(64),width:600,height:900,aiGenerated:false}}});
  const coverAssetId=exported.package.chapters[0].cover!.assetId;
  const received=prepareImport(exported.package,{[coverAssetId]:'photo-recipient-cover'});
  const draft:any={chapters:[{...received.chapter,packageCoverAssetId:received.coverAssetId,
    packageAssets:{[coverAssetId]:{photoId:received.assetPhotos[coverAssetId],aiGenerated:false}}}]};
  assert.equal(bookCoverSource(undefined,draft),'photo-recipient-cover');
  assert.equal(bookCoverSource('family_receiver_img_req-owncover',draft),'family_receiver_img_req-owncover');
  assert.equal(bookCoverSource(undefined,{...draft,chapters:[]}), '');
  assert.equal(bookCoverSource(undefined,{...draft,chapters:[{packageCoverAssetId:coverAssetId}]}), '');
});
