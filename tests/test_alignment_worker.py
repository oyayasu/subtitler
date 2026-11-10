import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave

path = Path(__file__).resolve().parents[1] / 'python' / 'align_words.py'
spec = importlib.util.spec_from_file_location('alignment_worker', path)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class WorkerTests(unittest.TestCase):
    def test_unicode_text_and_char_mapping(self):
        words = [{'id':'1','text':'Olá,'},{'id':'2','text':'você?'},{'id':'3','text':'123'}]
        text, spans = w.alignment_text(words, 'pt')
        self.assertEqual(text, 'Olá você cento e vinte e três')
        chars=[{'char':c,'start':i*.1,'end':i*.1+.08,'score':.9} for i,c in enumerate(text)]
        result={'segments':[{'chars':chars}]}
        hits=w.extract_words(text,spans,result,words,2,10,set('olávocê'))
        self.assertEqual(hits[0]['start'],2)
        self.assertEqual(hits[1]['start'],2.4)
        self.assertEqual(hits[2]['status'],'unaligned')
        complete=w.extract_words(text,spans,result,words,2,10,set(text.lower())-{' '})
        self.assertEqual(complete[2]['status'],'aligned')
        self.assertEqual(words[2]['text'],'123')
        self.assertEqual(words[0]['text'],'Olá,')
        self.assertEqual(w.alignment_text([{'text':'日本語。'},{'text':'です'}],'ja')[0],'日本語です')

    def test_no_fake_times_for_missing_chars_low_scores_and_mapping_mismatch(self):
        words=[{'id':'1','text':'Hello'}];text,spans=w.alignment_text(words,'en')
        for chars in [[],[{'char':c,'start':0.,'end':.1,'score':.01} for c in text],
                      [{'char':c} for c in text], [{'char':c,'start':float('nan'),'end':.1} for c in text]]:
            hit=w.extract_words(text,spans,{'segments':[{'chars':chars}]},words,0,5,set('helo'))[0]
            self.assertEqual(hit,{'id':'1','status':'unaligned'})

    def test_runner_reads_only_short_wav_windows_and_passes_original_offset(self):
        import numpy as np
        class Torch:
            @staticmethod
            def set_num_threads(n): pass
        request={'language':'en','threads':6,'duration':10,'cues':[{'id':'c','start':4,'end':6,'words':[{'id':'w','text':'Hello!'}]}]}
        seen=[]
        def align(segments,model,metadata,samples,device,**kw):
            seen.append(len(samples)); self.assertTrue(kw['return_char_alignments']);self.assertEqual(device,'cpu')
            return {'segments':[{'chars':[{'char':c,'start':1+i*.1,'end':1+i*.1+.08,'score':.9} for i,c in enumerate('Hello')]}]}
        def load(**kw):return None,{'type':'test','dictionary':set('helo')}
        with tempfile.TemporaryDirectory() as d:
            audio=Path(d)/'audio.wav'
            with wave.open(str(audio),'wb') as f:f.setparams((1,2,16000,0,'NONE',''));f.writeframes(b'\0'*320000)
            result=w.run(request,audio,align,load,np,Torch)
            self.assertEqual(seen,[64000]);self.assertEqual(result['cues'][0]['words'][0]['start'],4)
            request['duration']=20
            with self.assertRaisesRegex(ValueError,'duration changed'):w.run(request,audio,align,load,np,Torch)

    def test_mixed_language_groups_keep_word_and_caption_identities(self):
        cues=[{'id':'a','start':0,'end':2,'words':[{'id':'en','text':'Hello','start':0,'end':.8},{'id':'ja','text':'こんにちは','start':1,'end':1.8}]},
              {'id':'b','start':2,'end':3,'language':'pt','words':[{'id':'pt','text':'Olá','start':2,'end':2.8}]}]
        groups=w.alignment_groups(cues,'auto',True,'en')
        self.assertEqual([g['language'] for g in groups],['en','ja','pt'])
        self.assertEqual([x for g in groups for x in g['locations']],[(0,0),(0,1),(1,0)])
        groups=w.alignment_groups([cues[0]],'en',False,'en')
        self.assertEqual(len(groups),1)
        self.assertEqual(groups[0]['language'],'en')

    def test_neighboring_captions_share_context_without_changing_division(self):
        cues=[{'id':'a','start':0,'end':1,'words':[{'id':'a1','text':'Hello','start':0,'end':.8}]},
              {'id':'b','start':1,'end':2,'words':[{'id':'b1','text':'world','start':1,'end':1.8}]}]
        groups=w.alignment_groups(cues,'en')
        self.assertEqual(len(groups),1)
        self.assertEqual(groups[0]['locations'],[(0,0),(1,0)])
        self.assertEqual(cues[0]['id'],'a')
        cues[1]['words'][0]['start']=25;cues[1]['words'][0]['end']=26
        self.assertEqual(len(w.alignment_groups(cues,'en')),2)

    def test_one_speaker_skips_diarization_dependencies(self):
        result={'cues':[{'words':[{'id':'one','status':'aligned','start':0,'end':1}]}]}
        w.label_speakers(result,None,{'speakers':1})
        self.assertEqual(result['cues'][0]['words'][0]['speaker'],'Speaker 1')

    def test_probe_fails_cleanly_without_environment(self):
        with tempfile.TemporaryDirectory() as d:
            p=subprocess.run([sys.executable,str(path),'--probe','--output',str(Path(d)/'o.json')],capture_output=True,text=True)
            # This test environment deliberately does not have WhisperX installed.
            if p.returncode:
                self.assertIn('SUBTITLER ',p.stderr)
                self.assertFalse((Path(d)/'o.json').exists())

if __name__=='__main__':unittest.main()
