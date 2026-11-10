"""Internal alignment readings; original caption text and IDs never change."""
import re
ONES={'en':'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(),'pt':'zero um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete dezoito dezenove'.split(),'es':'cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve'.split()}
TENS={'en':'twenty thirty forty fifty sixty seventy eighty ninety'.split(),'pt':'vinte trinta quarenta cinquenta sessenta setenta oitenta noventa'.split(),'es':'veinte treinta cuarenta cincuenta sesenta setenta ochenta noventa'.split()}
def cardinal(n,language):
    if language=='ja':
        if n==0:return 'ゼロ'
        if n>9999:return None
        digits='零一二三四五六七八九';out=''
        for unit,name in [(1000,'千'),(100,'百'),(10,'十')]:
            k,n=divmod(n,unit)
            if k:out+=(digits[k] if k>1 else '')+name
        return out+(digits[n] if n else '')
    if language not in ONES or n>999999:return None
    if n<20:return ONES[language][n]
    if n<100:
        a,b=divmod(n,10)
        if language=='es' and n<30:return {20:'veinte',21:'veintiuno',22:'veintidós',23:'veintitrés',24:'veinticuatro',25:'veinticinco',26:'veintiséis',27:'veintisiete',28:'veintiocho',29:'veintinueve'}[n]
        return TENS[language][a-2]+((' ' if language=='en' else ' e ' if language=='pt' else ' y ')+ONES[language][b] if b else '')
    if n<1000:
        a,b=divmod(n,100)
        if language=='en':head=ONES['en'][a]+' hundred'
        elif language=='pt':head=('cem' if n==100 else 'cento') if a==1 else ['duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'][a-2]
        else:head=('cien' if n==100 else 'ciento') if a==1 else ['doscientos','trescientos','cuatrocientos','quinientos','seiscientos','setecientos','ochocientos','novecientos'][a-2]
        return head+((' e ' if language=='pt' else ' ')+cardinal(b,language) if b else '')
    a,b=divmod(n,1000);head=cardinal(a,language)+' thousand' if language=='en' else ('' if a==1 else cardinal(a,language)+' ')+'mil'
    return head+((' e ' if language=='pt' and b<100 else ' ')+cardinal(b,language) if b else '')
def spoken_form(text,language):
    raw=text.strip().strip('.,!?;:()[]"“”')
    return cardinal(int(raw),language) or text if re.fullmatch(r'\d{1,6}',raw) else text
