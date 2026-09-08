import base64
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

from lxml import html
from markdown_it import MarkdownIt

import convert_epub as epub


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / '含 空格 mārga.epub'
        self.output = self.root / 'converted'

    def make_book(self, epub3=False, image='images/图 (1).png', link='a.xhtml#note'):
        toc = ('<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>'
               if epub3 else '<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>')
        with zipfile.ZipFile(self.source, 'w') as z:
            z.writestr('mimetype', 'application/epub+zip')
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
            z.writestr('OPS/book.opf', f'''<package xmlns="http://www.idpf.org/2007/opf">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>同名章节测试</dc:title></metadata>
              <manifest><item id="z" href="z.xhtml" media-type="application/xhtml+xml"/>
                <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>{toc}</manifest>
              <spine toc="toc"><itemref idref="z"/><itemref idref="a"/></spine></package>''')
            z.writestr('OPS/toc.ncx', '''<ncx><navMap>
              <navPoint><navLabel><text>同名章节</text></navLabel><content src="z.xhtml"/></navPoint>
              <navPoint><navLabel><text>同名章节</text></navLabel><content src="a.xhtml"/></navPoint>
              </navMap></ncx>''')
            z.writestr('OPS/nav.xhtml', '''<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
              <body><nav epub:type="toc"><ol><li><a href="z.xhtml">同名章节</a></li>
              <li><a href="a.xhtml">同名章节</a></li></ol></nav></body></html>''')
            # Filename order intentionally differs from the reading order.
            z.writestr('OPS/a.xhtml', '''<html xmlns="http://www.w3.org/1999/xhtml"><body>
              <h2>后篇</h2><p id="note">注释正文</p><a href="z.xhtml#title">返回</a></body></html>''')
            z.writestr('OPS/z.xhtml', f'''<html xmlns="http://www.w3.org/1999/xhtml"><body>
              <h1 id="title">前篇</h1><p>前文<b>【重点】</b>后文 &amp; &lt;&gt; [ ] * 原符号</p>
              <ul><li>甲项</li><li>乙项</li></ul>
              <table><tr><td>甲列</td><td>乙列</td></tr><tr><td>甲值</td><td>乙值</td></tr></table>
              <a href="{link}" title="脚注说明">注释</a><img src="{image}" alt="原图"/></body></html>''')
            z.writestr('OPS/images/图 (1).png', base64.b64decode(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='))

    def test_auto_single_preserves_text_images_order_and_original(self):
        self.make_book()
        original = self.source.read_bytes()
        result = epub.run(self.source, self.output)
        self.assertEqual(result['layout'], 'single')
        self.assertEqual(result['markdown_files'], 1)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual({p.name for p in self.output.glob('*.md')}, {'README.md', 'content.md'})
        document = html.fragment_fromstring(MarkdownIt('commonmark').enable('table').render(
            (self.output / 'content.md').read_text()), create_parent='div')
        text = ''.join(document.itertext())
        self.assertLess(text.index('前文'), text.index('注释正文'))
        self.assertIn('后文 & <> [ ] * 原符号', text)
        self.assertEqual(len(document.findall('.//table')), 1)
        with zipfile.ZipFile(self.source) as z:
            self.assertEqual((self.output / 'images/OPS/images/图 (1).png').read_bytes(),
                             z.read('OPS/images/图 (1).png'))

    def test_epub3_split_preserves_cross_file_links_and_duplicate_titles(self):
        self.make_book(epub3=True)
        result = epub.run(self.source, self.output, layout='split')
        self.assertEqual(result['markdown_files'], 2)
        self.assertFalse((self.output / 'content.md').exists())
        report = json.loads((self.output / 'conversion-report.json').read_text())
        self.assertEqual(report['html_outside_spine'], [])
        self.assertEqual([p['pages'] for p in report['parts']], [['OPS/z.xhtml'], ['OPS/a.xhtml']])
        for part in report['parts']:
            page = html.fragment_fromstring(MarkdownIt().render((self.output / part['file']).read_text()), create_parent='div')
            for href in page.xpath('//a/@href'):
                link = urlsplit(href)
                destination = self.output / unquote(link.path)
                self.assertTrue(destination.is_file())
                target = html.fragment_fromstring(MarkdownIt().render(destination.read_text()), create_parent='div')
                self.assertIn(link.fragment, target.xpath('//@id'))

    def test_inspect_is_read_only_and_existing_output_is_protected(self):
        self.make_book()
        self.assertEqual(epub.run(self.source, self.output, inspect_only=True)['spine_pages'], 2)
        self.assertFalse(self.output.exists())
        self.output.mkdir()
        marker = self.output / 'user.md'
        marker.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            epub.run(self.source, self.output)
        self.assertEqual(marker.read_text(), 'keep')

    def test_bad_image_path_is_rejected_without_output(self):
        self.make_book(image='../../outside.png')
        with self.assertRaisesRegex(ValueError, 'Unsafe EPUB member'):
            epub.run(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_missing_footnote_target_is_rejected_without_output(self):
        self.make_book(link='not-in-spine.xhtml#note')
        with self.assertRaisesRegex(ValueError, 'internal link targets missing'):
            epub.run(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_text_loss_is_rejected_without_output(self):
        self.make_book()
        with patch.object(epub.Converter, 'convert', return_value='lost text'):
            with self.assertRaisesRegex(ValueError, 'Text mismatch'):
                epub.run(self.source, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
