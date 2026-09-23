import {expect,it} from 'vitest';
import {fileCopyPaths} from '../src/renderer/replica/workbench/FilePathMenu';
it('resolves relative paths against the project and normalizes dot segments',()=>{
 expect(fileCopyPaths('src/../src/a file.ts','/Users/me/project/')).toEqual({absolute:'/Users/me/project/src/a file.ts',relative:'src/a file.ts'});
});
it('keeps external absolute files and calculates a true relative path',()=>{
 expect(fileCopyPaths('/Users/me/project-other/a.ts','/Users/me/project')).toEqual({absolute:'/Users/me/project-other/a.ts',relative:'../project-other/a.ts'});
});
it('does not invent an absolute path without a workspace',()=>{
 expect(fileCopyPaths('src/a.ts')).toEqual({absolute:undefined,relative:undefined});
 expect(fileCopyPaths('/tmp/a.ts')).toEqual({absolute:'/tmp/a.ts',relative:undefined});
});
