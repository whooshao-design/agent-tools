#!/usr/bin/env python3
"""Convert a local EPUB into one verified Markdown edition, preserving its source."""

import argparse
import hashlib
import html as html_std
import json
import posixpath
import re
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit

from lxml import etree, html
from markdown_it import MarkdownIt
from markdownify import MarkdownConverter


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(text):
    return re.sub(r'\s+', '', text)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def resolve(base, href):
    url = urlsplit(href)
    require(not url.scheme and not url.netloc, f'Expected an EPUB-local reference: {href}')
    path = unquote(url.path)
    member = posixpath.normpath(posixpath.join(posixpath.dirname(base), path)) if path else base
    require(not PurePosixPath(member).is_absolute() and '..' not in PurePosixPath(member).parts,
            f'Unsafe EPUB member: {member}')
    return member, unquote(url.fragment)


def anchor(member, fragment=''):
    return 'epub-' + hashlib.sha256((member + '#' + fragment).encode()).hexdigest()[:24]


def xml(archive, member):
    return etree.fromstring(archive.read(member),
                           etree.XMLParser(resolve_entities=False, no_network=True))


def read_book(archive):
    container = xml(archive, 'META-INF/container.xml')
    opf_path, _ = resolve('', container.find('.//{*}rootfile').get('full-path'))
    opf = xml(archive, opf_path)
    manifest = {e.get('id'): e for e in opf.find('{*}manifest')}
    spine_node = opf.find('{*}spine')
    spine = [resolve(opf_path, manifest[e.get('idref')].get('href'))[0] for e in spine_node]
    require(spine and len(spine) == len(set(spine)), 'Empty spine or duplicate spine entries')
    starts = {}
    toc_id = spine_node.get('toc')
    if toc_id in manifest:
        ncx_path, _ = resolve(opf_path, manifest[toc_id].get('href'))
        for point in xml(archive, ncx_path).find('{*}navMap'):
            member, _ = resolve(ncx_path, point.find('{*}content').get('src'))
            starts.setdefault(member, point.findtext('{*}navLabel/{*}text') or member)
    else:
        nav_item = next((e for e in manifest.values() if 'nav' in e.get('properties', '').split()), None)
        if nav_item is not None:
            nav_path, _ = resolve(opf_path, nav_item.get('href'))
            for nav in xml(archive, nav_path).findall('.//{*}nav'):
                if 'toc' in nav.get('{http://www.idpf.org/2007/ops}type', '').split():
                    for a in nav.findall('{*}ol/{*}li/{*}a'):
                        member, _ = resolve(nav_path, a.get('href'))
                        starts.setdefault(member, ''.join(a.itertext()).strip())
    all_html = {resolve(opf_path, e.get('href'))[0] for e in manifest.values()
                if e.get('media-type') in ('application/xhtml+xml', 'text/html')
                and 'nav' not in e.get('properties', '').split()}
    title = opf.findtext('{*}metadata/{*}title') or 'EPUB'
    pages = []
    group, group_title, context = 0, title, title
    for member in spine:
        body = xml(archive, member).find('.//{*}body')
        require(body is not None, f'No XHTML body: {member}')
        require(not body.findall('.//{*}svg'), f'Inline SVG requires separate handling: {member}')
        # Remove non-reading code without dropping the text following it.
        for node in body.xpath('.//*[local-name()="script" or local-name()="style"]'):
            parent, previous, tail = node.getparent(), node.getprevious(), node.tail or ''
            parent.remove(node)
            if previous is None:
                parent.text = (parent.text or '') + tail
            else:
                previous.tail = (previous.tail or '') + tail
        if member in starts:
            group += 1
            group_title = starts[member]
        first_context = None
        for element in body.iter():
            if not isinstance(element.tag, str):
                continue
            tag = etree.QName(element).localname
            text = ''.join(element.itertext()).strip()
            if tag in ('h1', 'h2'):
                context = text
            if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li') and text and first_context is None:
                first_context = context
        pages.append({'member': member, 'body': body, 'group': group,
                      'title': group_title, 'context': first_context or context,
                      'end_context': context,
                      'characters': len(canonical(''.join(body.itertext())))})
    return title, pages, sorted(all_html - set(spine))


class Converter(MarkdownConverter):
    def process_tag(self, node, parent_tags=None):
        result = super().process_tag(node, parent_tags)
        if node.get('id'):
            marker = f'<a id="{node["id"]}"></a>'
            if node.name in ('body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'aside'):
                return '\n\n' + marker + '\n\n' + result.strip() + '\n\n'
            return marker + result
        return result


def rendered_text(parser, markdown):
    document = html.fragment_fromstring(parser.render(markdown), create_parent='div')
    return canonical(''.join(document.itertext()))


def convert_pages(archive, pages, warnings):
    parser = MarkdownIt('commonmark').enable('table')
    options = dict(heading_style='ATX', bullets='-', escape_misc=True, bs4_options='lxml',
                   keep_inline_images_in=['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    converter, plain_bold = Converter(**options), Converter(strip=['b', 'strong'], **options)
    images, link_targets = set(), set()
    members = set(archive.namelist())
    for i, page in enumerate(pages, 1):
        body, member = page['body'], page['member']
        expected = canonical(''.join(body.itertext()))
        for element in body.iter():
            if not isinstance(element.tag, str):
                continue
            tag = etree.QName(element).localname
            element.tag = tag
            original_id = element.get('id') or (element.get('name') if tag == 'a' else None)
            if original_id:
                element.set('id', anchor(member, original_id))
            if tag == 'img' and element.get('src'):
                src = element.get('src')
                if urlsplit(src).scheme or urlsplit(src).netloc:
                    warnings.append({'kind': 'external_image_not_downloaded', 'page': member})
                else:
                    target, _ = resolve(member, src)
                    require(target in members, f'Missing image in {member}: {target}')
                    images.add(target)
                    element.set('src', quote('images/' + target))
            if tag == 'a' and element.get('href'):
                href = element.get('href')
                if not urlsplit(href).scheme and not urlsplit(href).netloc:
                    target, fragment = resolve(member, href)
                    target_id = anchor(target, fragment)
                    link_targets.add(target_id)
                    element.set('href', '#' + target_id)
        source_html = etree.tostring(body, encoding='unicode')
        md = converter.convert(source_html).strip() + '\n'
        actual = rendered_text(parser, md)
        if actual != expected:
            fallback = plain_bold.convert(source_html).strip() + '\n'
            if rendered_text(parser, fallback) == expected:
                md, actual = fallback, expected
                warnings.append({'kind': 'bold_format_simplified', 'page': member})
        if actual != expected:
            offset = next((j for j, (a, b) in enumerate(zip(actual, expected)) if a != b),
                          min(len(actual), len(expected)))
            raise ValueError(f'Text mismatch: {member}, non-whitespace character offset {offset}')
        page['md'] = f'<a id="{anchor(member)}"></a>\n\n' + md
        if i % 250 == 0:
            print(f'Checked {i}/{len(pages)} pages', file=sys.stderr, flush=True)
    return images, link_targets


def split_pages(pages, layout, target):
    batches, batch, size = [], [], 0
    for page in pages:
        if layout == 'split' and batch and (page['group'] != batch[-1]['group']
                                            or size + page['characters'] > target):
            batches.append(batch)
            batch, size = [], 0
        batch.append(page)
        size += page['characters']
    if batch:
        batches.append(batch)
    return batches


def markdown_label(text):
    return MarkdownConverter(escape_misc=True).convert('<span>' + html_std.escape(text) + '</span>')


def run(source, output=None, layout='auto', target=400_000, inspect_only=False):
    source = Path(source).resolve(strict=True)
    require(target > 0, 'target-chars must be positive')
    source_hash = digest(source)
    output = Path(output) if output else source.with_name(source.stem + '-md')
    require(inspect_only or not (output.exists() or output.is_symlink()), f'Output already exists: {output}')
    warnings = []
    with zipfile.ZipFile(source) as archive:
        title, pages, outside_spine = read_book(archive)
        count = sum(p['characters'] for p in pages)
        report = {'source': source.name, 'source_sha256': source_hash, 'title': title,
                  'spine_pages': len(pages), 'characters_without_whitespace': count,
                  'html_outside_spine': outside_spine,
                  'textless_pages': [p['member'] for p in pages if not p['characters']],
                  'oversized_pages': [p['member'] for p in pages if p['characters'] > target]}
        if inspect_only:
            return report
        if outside_spine:
            warnings.append({'kind': 'html_outside_spine_not_converted', 'count': len(outside_spine)})
        images, link_targets = convert_pages(archive, pages, warnings)
        chosen = ('single' if count <= target else 'split') if layout == 'auto' else layout
        batches = split_pages(pages, chosen, target)
        require([p['member'] for batch in batches for p in batch] == [p['member'] for p in pages],
                'Page order or coverage changed during splitting')
        documents, locations = [], {}
        for i, batch in enumerate(batches, 1):
            label = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', batch[0]['title'])[:60].strip('. ')
            filename = 'content.md' if chosen == 'single' else f'{i:03d}_{label or "chapter"}.md'
            content = '\n'.join(p['md'] for p in batch)
            for marker in re.findall(r'<a id="(epub-[a-f0-9]+)"></a>', content):
                require(marker not in locations, f'Duplicate source anchor: {marker}')
                locations[marker] = filename
            documents.append((filename, batch, content))
        missing = link_targets - locations.keys()
        require(not missing, f'{len(missing)} internal link targets missing; inspect non-spine HTML or original links')
        require('\n'.join(d[2] for d in documents) == '\n'.join(p['md'] for p in pages),
                'Split body differs from complete converted body')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.epub-md-', dir=output.parent) as temporary:
            stage = Path(temporary) / 'result'
            stage.mkdir()
            summary = []
            parser = MarkdownIt('commonmark').enable('table')
            for filename, batch, content in documents:
                content = re.sub(r'(?<=\]\()#(epub-[a-f0-9]+)(?=[\s)])',
                                 lambda m: quote(locations[m[1]]) + '#' + m[1], content)
                header = (f'> 来源：{markdown_label(source.name)}。起始章节：{markdown_label(batch[0]["context"])}。'
                          '图片未做 OCR；单独上传 Markdown 时需另附相关图片。\n\n')
                path = stage / filename
                path.write_text(header + content, encoding='utf-8')
                expected = canonical(''.join(''.join(p['body'].itertext()) for p in batch))
                require(rendered_text(parser, path.read_text(encoding='utf-8').split('\n\n', 1)[1]) == expected,
                        f'Final output text mismatch: {filename}')
                summary.append({'file': filename, 'characters': sum(p['characters'] for p in batch),
                                'first_chapter': batch[0]['context'], 'last_chapter': batch[-1]['end_context'],
                                'bytes': path.stat().st_size, 'pages': [p['member'] for p in batch]})
            for member in images:
                path = stage / 'images' / member
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(member))
                require(path.read_bytes() == archive.read(member), f'Image changed: {member}')
            # Validate the actual rendered destinations after all output files exist.
            for part in summary:
                document = html.fragment_fromstring(parser.render((stage / part['file']).read_text()), create_parent='div')
                for destination in document.xpath('//img/@src | //a/@href'):
                    url = urlsplit(destination)
                    if not url.scheme and not url.netloc:
                        target = stage / unquote(url.path)
                        require(target.is_file(), f'Output link does not resolve: {destination}')
                        if url.fragment:
                            require(locations.get(unquote(url.fragment)) == unquote(url.path),
                                    f'Output anchor does not resolve: {destination}')
            report.update(layout=chosen, markdown_files=len(documents), unique_images=len(images),
                          warnings=warnings, parts=summary, text_round_trip='pass',
                          source_unchanged=digest(source) == source_hash)
            require(report['source_unchanged'], 'Original EPUB changed during conversion')
            (stage / 'conversion-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            index = (f'# {markdown_label(title)}\n\n'
                     '原 EPUB 已保留；本目录仅包含一套 Markdown 正文。图片文字未做 OCR。\n\n'
                     '按需上传正文文件；引用时注明章节、日期（原文有日期时）和短原文依据。'
                     '找不到依据就明确说明，不把目录中的问题当作正文结论。\n\n'
                     f'已核对 {len(pages)} 个 spine 页面、{count:,} 个非空白文字字符，'
                     f'保留 {len(images)} 张不同的原图。校验详情与警告见 [转换报告](conversion-report.json)。\n\n')
            if warnings or report['oversized_pages'] or outside_spine:
                index += '转换包含需要查看的提示，不能据此断言所有附件或图片都已转成文字。\n\n'
            for part in summary:
                index += (f'- [{markdown_label(part["file"])}]({quote(part["file"])})：'
                          f'{part["bytes"]/1_000_000:.2f} MB；'
                          f'{markdown_label(part["first_chapter"])} → {markdown_label(part["last_chapter"])}。\n')
            (stage / 'README.md').write_text(index, encoding='utf-8')
            require(not (output.exists() or output.is_symlink()), f'Output appeared during conversion: {output}')
            stage.rename(output)
    return {k: report[k] for k in ('layout', 'spine_pages', 'markdown_files', 'unique_images',
                                   'text_round_trip', 'source_unchanged')} | {'output': str(output), 'warnings': len(warnings)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--layout', choices=['auto', 'single', 'split'], default='auto')
    parser.add_argument('--target-chars', type=int, default=400_000)
    parser.add_argument('--inspect', action='store_true')
    args = parser.parse_args()
    try:
        result = run(args.source, args.output_dir, args.layout, args.target_chars, args.inspect)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, etree.XMLSyntaxError) as error:
        parser.exit(1, f'Conversion failed: {error}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
