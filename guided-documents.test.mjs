import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { extractDocument, signDocument, readDocument, MAX_FILE_BYTES } from './guided-documents.mjs';
import { registerGuidedDemo, guidedTurn } from './guided-demo.mjs';
process.env.OPENAI_API_KEY ||= 'test-only-document-signing-key';
const tex = String.raw`\section{Learning} A learner studies a document, applies a principle to a concrete situation, and explains why the decision is suitable. This is a local test fixture.`;
test('LaTeX is read as text without executing includes', async () => {
  const doc = await extractDocument({originalname:'lesson.tex',buffer:Buffer.from(tex)});
  assert.match(doc.MATERIAL,/section/);
  await assert.rejects(extractDocument({originalname:'script.js',buffer:Buffer.from(tex)}),/Supported files/);
  await assert.rejects(extractDocument({originalname:'large.tex',buffer:Buffer.from('a'.repeat(12001))}),/too much text/);
});
test('PowerPoint and Word extraction preserve readable text', async () => {
  const ppt = new JSZip(); ppt.file('ppt/slides/slide1.xml',`<p:sld xmlns:p="p" xmlns:a="a"><a:t>${tex.replaceAll('&','&amp;')}</a:t></p:sld>`);
  const doc = await extractDocument({originalname:'lesson.pptx',buffer:await ppt.generateAsync({type:'nodebuffer'})});
  assert.match(doc.MATERIAL,/learner studies/);
  const word = new JSZip(); word.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  word.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${tex}</w:t></w:r></w:p></w:body></w:document>`);
  assert.match((await extractDocument({originalname:'lesson.docx',buffer:await word.generateAsync({type:'nodebuffer'})})).MATERIAL,/learner studies/);
});
test('signed uploaded material drives the activity and rejects tampering', async () => {
  const token=signDocument({MATERIAL:tex,title:'lesson.tex',STEPS:Array.from({length:3},(_,i)=>({title:'Topic '+i,goal:'Apply a principle',scenario:'Study this document.',question:'Why?'}))});
  assert.equal(readDocument(token).title,'lesson.tex');
  assert.throws(()=>readDocument(token+'x'),/Invalid/);
  const result=await guidedTurn({}, {action:'start',document_token:token});
  assert.equal(result.material,tex); assert.equal(result.steps[0].title,'Topic 0');
});
test('HTTP rejects unsupported and oversized uploads without calling AI', async () => {
  const app=express(); app.use(express.json());
  let calls=0; registerGuidedDemo(app,{chat:{completions:{create:()=>{calls++;throw Error('must not run');}}}});
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.on('listening',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/api/public/guided/document`;
    for (const [name,content] of [['bad.exe','no'],['too-big.pdf','a'.repeat(MAX_FILE_BYTES+1)]]) {
      const form=new FormData(); form.append('document',new Blob([content]),name);
      const response=await fetch(url,{method:'POST',body:form}); assert.equal(response.status,422);
    }
    assert.equal(calls,0);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('PDF extraction reads selectable text', async () => {
  const text = "Students inspect evidence, adapt their plan, and explain why a change helps the learning goal. A short example makes the principle concrete.";
  const stream = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf += `${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const document = await extractDocument({originalname:'lesson.pdf',buffer:Buffer.from(pdf)});
  assert.match(document.MATERIAL,/Students inspect evidence/);
});
